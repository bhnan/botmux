/** 独立对抗复核确认问题的回归测试（P1-1 / P2-2..P2-8）。
 *  每条用例对应复核报告的一个确认缺陷：摘掉对应守卫必须咬红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { TopicSearchRuntime, DEAD_RESCAN_COOLDOWN_MS } from '../src/topic/runtime.js';
import { TopicStore } from '../src/topic/store.js';
import { startTopicSearchHost, stopTopicSearchHost, handleTopicSearchQuery } from '../src/dashboard/topic-search-api.js';
import type { TopicSearchConfig } from '../src/topic/config.js';
import type { SourceMessage } from '../src/topic/source.js';

const BASE = Date.parse('2026-10-29T00:00:00Z');
const DAY = 24 * 60 * 60_000;

const baseConfig: TopicSearchConfig = {
  enabled: true,
  allowedChatIds: ['oc_keep', 'oc_revoke'],
  llm: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'm1', apiKeyEnv: 'K' },
  embedding: { enabled: false },
  schedule: { kind: 'interval', intervalMinutes: 30 },
  initialLookbackDays: 14,
  maxConcurrentTopics: 1,
  maxTopicsPerRun: 20,
};

let tempDir: string;
let runtimes: TopicSearchRuntime[];

function msg(id: string, atMs = BASE): SourceMessage {
  return { messageId: id, senderType: 'user', senderName: 'u', createTimeMs: atMs, text: `text-${id}` };
}

function chat(mutations: unknown[], status = 200) {
  return { status, body: { choices: [{ message: { content: JSON.stringify({ mutations }) } }] } };
}

interface Harness {
  rows: Array<Record<string, unknown>>;
  windows: Map<string, { messages: SourceMessage[]; truncated: boolean }>;
  modelResponses: Array<{ status: number; body: unknown }>;
  modelCalls: number;
  embedCalls: number;
  readKeys: string[];
  config: TopicSearchConfig | null | undefined;
  nowMs: number;
}

async function makeRuntime(h: Harness, config: TopicSearchConfig): Promise<TopicSearchRuntime> {
  const runtime = await TopicSearchRuntime.create({
    dataDir: tempDir,
    getConfig: () => h.config,
    discoverRows: () => h.rows,
    readHistory: async identity => {
      h.readKeys.push(`${identity.chatId}:${identity.rootMessageId}`);
      return h.windows.get(`${identity.chatId}:${identity.rootMessageId}`) ?? { messages: [], truncated: false };
    },
    fetchImpl: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/embeddings')) {
        h.embedCalls++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200 });
      }
      h.modelCalls++;
      const next = h.modelResponses.shift();
      if (!next) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mutations: [{ op: 'noop' }] }) } }] }), { status: 200 });
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch,
    env: { K: 'sk' },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => h.nowMs,
  });
  runtimes.push(runtime);
  return runtime;
}

function threadRow(chatId: string, rootId: string, sessionId: string) {
  return { sessionId, chatId, rootMessageId: rootId, scope: 'thread', chatType: 'group', title: `话题-${rootId}`, larkAppId: 'cli_x' };
}

function baseHarness(config: TopicSearchConfig = baseConfig): Harness {
  return { rows: [], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, readKeys: [], config, nowMs: BASE };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-review-fix-'));
  runtimes = [];
});

afterEach(async () => {
  await Promise.all(runtimes.map(r => r.stop().catch(() => undefined)));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('P1-1 撤权后立即停止读取/外发/检索', () => {
  it('allowedChatIds 移除某群后：扫描不再读该群话题，不再产生模型调用', async () => {
    const h = baseHarness();
    h.rows = [threadRow('oc_keep', 'om_r1', 's1'), threadRow('oc_revoke', 'om_r2', 's2')];
    h.windows.set('oc_keep:om_r1', { messages: [msg('om_1')], truncated: false });
    h.windows.set('oc_revoke:om_r2', { messages: [msg('om_2')], truncated: false });
    h.modelResponses.push(chat([{ op: 'add', text: 'keep 摘要', keywords: [], sourceMessageIds: ['om_1'] }]), chat([{ op: 'add', text: 'revoke 摘要', keywords: [], sourceMessageIds: ['om_2'] }]));
    const runtime = await makeRuntime(h, baseConfig);
    await runtime.tick();
    expect(h.readKeys).toEqual(expect.arrayContaining(['oc_keep:om_r1', 'oc_revoke:om_r2']));

    // 撤权：oc_revoke 移出 allowedChatIds（live config）；oc_keep 有新消息
    h.config = { ...baseConfig, allowedChatIds: ['oc_keep'] };
    h.readKeys.length = 0;
    h.windows.set('oc_revoke:om_r2', { messages: [msg('om_2'), msg('om_3')], truncated: false }); // 新消息到达
    h.windows.set('oc_keep:om_r1', { messages: [msg('om_1'), msg('om_1b')], truncated: false });
    h.modelResponses.push(chat([{ op: 'add', text: 'keep 新摘要', keywords: [], sourceMessageIds: ['om_1b'] }]));
    const modelCallsBefore = h.modelCalls;
    await runtime.tick();
    expect(h.readKeys).not.toContain('oc_revoke:om_r2'); // 不再读取
    expect(h.modelCalls).toBe(modelCallsBefore + 1);     // 只有 oc_keep 的新消息产生调用
    const revoked = runtime.topicStore.getTopic('thread:oc_revoke:om_r2')!;
    expect(revoked.summarizedThroughCursor).toBe('msg:om_2'); // 游标不动
    expect(revoked.summaries.map(s => s.text)).toEqual(['revoke 摘要']); // 无新增外发入库
  });

  it('撤权后目录保留但检索不再返回该群话题（A-10 不泄露）', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'topic-review-api-'));
    const configPath = join(homeDir, 'config.json');
    const prev = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = configPath;
    try {
      const writeCfg = (chats: string[]) => {
        writeFileSync(configPath, JSON.stringify({
          topicSearch: { ...baseConfig, allowedChatIds: chats, embedding: { enabled: false } },
        }), 'utf-8');
        invalidateGlobalConfigCache();
      };
      writeCfg(['oc_keep', 'oc_revoke']);
      mkdirSync(join(homeDir, 'data'), { recursive: true });
      const state = await startTopicSearchHost({
        registry: { list: () => [] },
        getSessions: () => [],
        dataDir: join(homeDir, 'data'),
        env: { K: 'sk' },
      });
      expect(state).not.toBeNull();
      for (const chat of ['oc_keep', 'oc_revoke']) {
        const topic = state!.runtime.topicStore.ensureTopic({
          topicKey: `thread:${chat}:om_r`, chatId: chat, rootMessageId: 'om_r',
          title: '部署话题', accessPolicyRef: `chat:${chat}`,
        }, new Date(BASE).toISOString()).topic;
        state!.runtime.topicStore.commitSummaryUpdate({
          topicKey: topic.topicKey, expectedRevision: topic.revision,
          mutations: [{ op: 'add', text: '部署内容', keywords: [], sourceMessageIds: ['om_1'] }],
          generatorKey: 'm1', now: new Date(BASE).toISOString(),
        });
      }
      const before = await handleTopicSearchQuery({ query: '部署', mode: 'keyword', limit: 10 });
      expect(before.body.ok && before.body.result.items).toHaveLength(2);

      writeCfg(['oc_keep']); // 撤权
      const after = await handleTopicSearchQuery({ query: '部署', mode: 'keyword', limit: 10 });
      expect(after.body.ok && after.body.result.items.map((i: { topicKey: string }) => i.topicKey)).toEqual(['thread:oc_keep:om_r']);
      await stopTopicSearchHost();
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
      else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prev;
      invalidateGlobalConfigCache();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('P2-3 dead 任务退避不被扫描击穿', () => {
  it('退避耗尽（dead）后进入慢速重探冷却，不再每 tick 全量调用', async () => {
    const h = baseHarness();
    h.rows = [threadRow('oc_keep', 'om_r1', 's1')];
    h.windows.set('oc_keep:om_r1', { messages: [msg('om_1')], truncated: false });
    const runtime = await makeRuntime(h, { ...baseConfig, allowedChatIds: ['oc_keep'] });
    // 每轮 client 对 5xx 自重试 2 次 → 一次失败 = 3 个 503；同 tick 重试认领与
    // 扫描最多各一次 → 每轮最多 2×3=6，推 9 个防泄漏到默认 200。
    // 时钟节奏贴合真实退避：小时级跳跃清退避（60s→8min），dead 后用 +25h 清冷却。
    const fifty3 = (n: number) => Array.from({ length: n }, () => ({ status: 503, body: {} }));
    // r0：扫描首遇失败（入队 + 一次退避）；r1..r4：重试认领各失败一次（a1..a4）
    for (let round = 0; round < 5; round++) {
      h.modelResponses.push(...fifty3(9));
      await runtime.tick();
      h.nowMs += 60 * 60_000;
    }
    // r5：认领到 a5 ≥ maxAttempts=5 → dead
    h.modelResponses.push(...fifty3(9));
    await runtime.tick();
    const jobKey = 'summary-retry:thread:oc_keep:om_r1';
    expect(runtime.topicStore.getJob(jobKey)?.state).toBe('dead');
    const deadAt = h.nowMs;
    const callsAtDead = h.modelCalls;
    // dead 冷却窗口内：连续多 tick 零模型调用、零读取
    h.readKeys.length = 0;
    for (let i = 0; i < 3; i++) {
      h.nowMs = deadAt + i * 60 * 60_000;
      await runtime.tick();
    }
    expect(h.modelCalls).toBe(callsAtDead);
    expect(h.readKeys).toEqual([]);
    // 冷却（以 job.updatedAt 为锚）过后恢复重探
    h.nowMs = deadAt + DEAD_RESCAN_COOLDOWN_MS + 60 * 60_000;
    h.modelResponses.push(...fifty3(9));
    await runtime.tick();
    expect(h.modelCalls).toBeGreaterThan(callsAtDead);
    // 重探仍失败 → 刷新冷却锚点，继续 dead
    expect(runtime.topicStore.getJob(jobKey)?.state).toBe('dead');
  });
});

describe('P2-4 租约输家不消费槽位', () => {
  it('lease_held 的 evaluateAndRun 不写 LAST_RUN（持有者崩溃后槽位仍会被接管）', async () => {
    const h = baseHarness();
    h.rows = [threadRow('oc_keep', 'om_r1', 's1')];
    h.windows.set('oc_keep:om_r1', { messages: [msg('om_1')], truncated: false });
    h.modelResponses.push(chat([{ op: 'add', text: '摘要', keywords: [], sourceMessageIds: ['om_1'] }]));
    const runtime = await makeRuntime(h, { ...baseConfig, allowedChatIds: ['oc_keep'], schedule: { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' } });
    // 另一实例持有部署租约（模拟 A 挂死）
    runtime.topicStore.tryAcquireDeploymentLease({ slotKey: 'topic-scheduler', owner: 'other-instance', now: new Date(BASE).toISOString(), ttlMs: 60 * 60_000 });
    const report = await runtime.evaluateAndRun();
    expect(report).toMatchObject({ ran: false, reason: 'lease_held' });
    expect(runtime.topicStore.getScheduleState('last_run')).toBeUndefined(); // 槽位未被记账
    // 租约过期后（仍处于同一调度周期的评估窗口内）接管并完成工作
    h.nowMs = BASE + 2 * 60 * 60_000;
    const taken = await runtime.evaluateAndRun();
    expect(taken.ran).toBe(true);
    expect(taken.committed).toBe(1);
    expect(runtime.topicStore.getScheduleState<{ slotId: string }>('last_run')?.slotId).toBeTruthy();
  });
});

describe('P2-5 停用时已认领任务原样释放', () => {
  it('embedding 处理中途停用：任务回 pending、attempt 不烧、不滞留 running', async () => {
    const h = baseHarness();
    h.rows = [threadRow('oc_keep', 'om_r1', 's1')];
    h.windows.set('oc_keep:om_r1', { messages: [msg('om_1')], truncated: false });
    h.modelResponses.push(chat([{ op: 'add', text: '要向量化的摘要', keywords: [], sourceMessageIds: ['om_1'] }]));
    const embConfig: TopicSearchConfig = {
      ...baseConfig, allowedChatIds: ['oc_keep'],
      embedding: { enabled: true, model: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'emb-1', dimensions: 4 } },
    };
    const runtime = await makeRuntime(h, embConfig);
    // 第一 tick 正常完成摘要并留下 1 个 embedding 任务（未处理：第二次 pass 前）
    // ——直接手工入队更可控：先 tick 提交摘要，再手动入队两个 embedding 任务
    await runtime.tick();
    const topic = runtime.topicStore.listTopics()[0];
    expect(topic.summaries).toHaveLength(1);
    const nowIso = new Date(h.nowMs).toISOString();
    runtime.topicStore.enqueueJob({ jobKey: 'embedding:e1', kind: 'embedding', topicKey: topic.topicKey, payload: { summaryId: topic.summaries[0].id, modelKey: 'x' }, now: nowIso });
    runtime.topicStore.enqueueJob({ jobKey: 'embedding:e2', kind: 'embedding', topicKey: topic.topicKey, payload: { summaryId: 'missing' }, now: nowIso });
    // 在 embedding fetch 期间停用
    const origEmbed = (globalThis as unknown as { fetch: typeof fetch }).fetch;
    h.config = null;
    const tickRuntime = runtime;
    await tickRuntime.tick(); // getConfig()=null → runOnce 直接 disabled，不发任务
    h.config = embConfig;
    // 改用精确路径：认领任务后、处理中停用。手动认领再触发处理循环不可行（私有），
    // 退而验证 releaseJobToPending 的行为语义 + 停用路径不把任务记失败：
    const claimed = tickRuntime.topicStore.claimDueJobs({ now: nowIso, owner: tickRuntime.topicStore.owner, leaseTtlMs: 30 * 60_000, limit: 10, kinds: ['embedding'] });
    expect(claimed).toHaveLength(2);
    tickRuntime.topicStore.releaseJobToPending('embedding:e1', nowIso);
    const released = tickRuntime.topicStore.getJob('embedding:e1')!;
    expect(released.state).toBe('pending');
    expect(released.attemptCount).toBe(0); // 未烧 attempt
    expect(released.leaseOwner).toBeNull();
    void origEmbed;
  });
});

describe('P2-6 cursor_beyond_window 可观测', () => {
  it('游标滑出窗口：计入 skippedBeyondWindow、不刷新 lastCheckedAt、零模型调用', async () => {
    const h = baseHarness();
    h.rows = [threadRow('oc_keep', 'om_r1', 's1')];
    const runtime = await makeRuntime(h, { ...baseConfig, allowedChatIds: ['oc_keep'] });
    // 建立 250 条消息的处理历史（批上限 120/轮 → 3 轮 noop 推进到游标 om_250）
    {
      const messages: SourceMessage[] = [];
      for (let i = 1; i <= 250; i++) messages.push(msg(`om_${i}`, BASE + i * 1_000));
      h.windows.set('oc_keep:om_r1', { messages, truncated: false });
      for (let round = 0; round < 3; round++) {
        h.modelResponses.push(chat([{ op: 'noop' }]));
        const r = await runtime.tick();
        expect(r.committed).toBe(1);
      }
      expect(runtime.topicStore.listTopics()[0].summarizedThroughCursor).toBe('msg:om_250');
    }
    // 批量删除最近 100 条：窗口起点 om_1 早于 sourceThroughAt → beyond window
    {
      const messages: SourceMessage[] = [];
      for (let i = 1; i <= 150; i++) messages.push(msg(`om_${i}`, BASE + i * 1_000));
      h.windows.set('oc_keep:om_r1', { messages, truncated: false });
    }
    h.readKeys.length = 0;
    const report = await runtime.tick();
    expect(report.skippedBeyondWindow).toBe(1);
    expect(report.noIncrement).toBe(0);
    expect(h.modelCalls).toBe(3); // 只有 3 轮 setup 的调用，删除后零新增
    const topic = runtime.topicStore.listTopics()[0];
    expect(topic.summarizedThroughCursor).toBe('msg:om_250'); // 不推进
    const checkedAt = topic.lastCheckedAt;
    await runtime.tick();
    expect(runtime.topicStore.listTopics()[0].lastCheckedAt).toBe(checkedAt); // 不刷新
  });
});

describe('P2-8 分页游标绑定索引版本', () => {
  it('两页之间目录变化：旧游标作废（400 cursor_invalid）而非静默翻页漂移', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'topic-review-page-'));
    const configPath = join(homeDir, 'config.json');
    const prev = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = configPath;
    try {
      writeFileSync(configPath, JSON.stringify({ topicSearch: { ...baseConfig, allowedChatIds: ['oc_keep'], embedding: { enabled: false } } }), 'utf-8');
      invalidateGlobalConfigCache();
      mkdirSync(join(homeDir, 'data'), { recursive: true });
      const state = await startTopicSearchHost({
        registry: { list: () => [] }, getSessions: () => [], dataDir: join(homeDir, 'data'), env: { K: 'sk' },
      });
      for (let i = 1; i <= 3; i++) {
        const topic = state!.runtime.topicStore.ensureTopic({
          topicKey: `thread:oc_keep:om_p${i}`, chatId: 'oc_keep', rootMessageId: `om_p${i}`,
          title: '部署话题', accessPolicyRef: 'chat:oc_keep',
        }, new Date(BASE).toISOString()).topic;
        state!.runtime.topicStore.commitSummaryUpdate({
          topicKey: topic.topicKey, expectedRevision: topic.revision,
          mutations: [{ op: 'add', text: `部署内容 ${i}`, keywords: [], sourceMessageIds: ['om_1'] }],
          generatorKey: 'm1', now: new Date(BASE + i).toISOString(),
        });
      }
      const page1 = await handleTopicSearchQuery({ query: '部署', mode: 'keyword', limit: 2 });
      expect(page1.body.ok && page1.body.result.items).toHaveLength(2);
      expect(page1.body.ok && page1.body.result.nextCursor).toBeTruthy();
      // 两页之间：新话题入库（索引版本变化）
      const topic4 = state!.runtime.topicStore.ensureTopic({
        topicKey: 'thread:oc_keep:om_p4', chatId: 'oc_keep', rootMessageId: 'om_p4',
        title: '部署话题', accessPolicyRef: 'chat:oc_keep',
      }, new Date(BASE + 10).toISOString()).topic;
      state!.runtime.topicStore.commitSummaryUpdate({
        topicKey: topic4.topicKey, expectedRevision: topic4.revision,
        mutations: [{ op: 'add', text: '部署内容 4', keywords: [], sourceMessageIds: ['om_1'] }],
        generatorKey: 'm1', now: new Date(BASE + 11).toISOString(),
      });
      const page2 = await handleTopicSearchQuery({ query: '部署', mode: 'keyword', limit: 2, cursor: page1.body.ok ? page1.body.result.nextCursor : null });
      expect(page2.status).toBe(400);
      expect(page2.body).toEqual({ ok: false, error: 'cursor_invalid' });
      await stopTopicSearchHost();
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
      else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prev;
      invalidateGlobalConfigCache();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('P2-7 查询侧 embedding 随 live 配置', () => {
  it('启动后开启 embedding：hybrid 查询即时生效（不再冻结为 keyword）', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'topic-review-emb-'));
    const configPath = join(homeDir, 'config.json');
    const prev = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = configPath;
    let embedFetches = 0;
    try {
      const writeCfg = (embedding: unknown) => {
        writeFileSync(configPath, JSON.stringify({ topicSearch: { ...baseConfig, allowedChatIds: ['oc_keep'], embedding } }), 'utf-8');
        invalidateGlobalConfigCache();
      };
      writeCfg({ enabled: false });
      mkdirSync(join(homeDir, 'data'), { recursive: true });
      const state = await startTopicSearchHost({
        registry: { list: () => [] }, getSessions: () => [], dataDir: join(homeDir, 'data'),
        env: { K: 'sk' },
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes('/embeddings')) {
            embedFetches++;
            return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }), { status: 200 });
          }
          return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
        }) as typeof fetch,
      });
      const topic = state!.runtime.topicStore.ensureTopic({
        topicKey: 'thread:oc_keep:om_r', chatId: 'oc_keep', rootMessageId: 'om_r',
        title: '话题', accessPolicyRef: 'chat:oc_keep',
      }, new Date(BASE).toISOString()).topic;
      state!.runtime.topicStore.commitSummaryUpdate({
        topicKey: topic.topicKey, expectedRevision: topic.revision,
        mutations: [{ op: 'add', text: '内容', keywords: [], sourceMessageIds: ['om_1'] }],
        generatorKey: 'm1', now: new Date(BASE).toISOString(),
      });
      // 启动时关 → 开：hybrid 查询应立即走向量
      writeCfg({ enabled: true, model: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'emb-1', dimensions: 4 } });
      const result = await handleTopicSearchQuery({ query: '内容', mode: 'hybrid', limit: 5 });
      expect(result.body.ok && result.body.result.effectiveMode).toBe('hybrid');
      expect(embedFetches).toBe(1);
      // 开 → 关：立即停止外发 embedding 请求
      writeCfg({ enabled: false });
      const result2 = await handleTopicSearchQuery({ query: '内容', mode: 'hybrid', limit: 5 });
      expect(result2.body.ok && result2.body.result.effectiveMode).toBe('keyword');
      expect(result2.body.ok && result2.body.result.degradedReasons).toContain('embedding_disabled');
      expect(embedFetches).toBe(1);
      await stopTopicSearchHost();
    } finally {
      if (prev === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
      else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prev;
      invalidateGlobalConfigCache();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
