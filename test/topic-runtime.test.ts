/** 后台 runtime 全链路（spec §5.2）：
 *  - 发现：仅授权群的 thread+om_ 锚点入目录；chat-scope/p2p/虚拟锚点不入
 *  - 无增量零模型调用；有增量提交并推进游标；同窗口第二轮无增量
 *  - 公平扫描：maxTopicsPerRun 限流 + 游标轮转（历史话题不饥饿）
 *  - 模型失败 → 重试任务带退避；下一 tick 不立即重跑
 *  - embedding 同 tick 二次处理（日频调度不拖一天）
 *  - 中途停用：模型调用前熔断；跨实例租约单飞
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TopicSearchRuntime, type TopicSearchRuntimeDeps } from '../src/topic/runtime.js';
import type { TopicSearchConfig } from '../src/topic/config.js';
import type { TopicHistoryWindow, SourceMessage, TopicHistoryReader } from '../src/topic/source.js';

let tempDir: string;
let runtimes: TopicSearchRuntime[];

const BASE = Date.parse('2026-10-29T00:00:00Z');
const DAY = 24 * 60 * 60_000;

const baseConfig: TopicSearchConfig = {
  enabled: true,
  allowedChatIds: ['oc_allowed'],
  llm: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'm1', apiKeyEnv: 'K' },
  embedding: { enabled: false },
  schedule: { kind: 'interval', intervalMinutes: 30 },
  initialLookbackDays: 14,
  maxConcurrentTopics: 1,
  maxTopicsPerRun: 20,
};

function msg(id: string, atMs = BASE): SourceMessage {
  return { messageId: id, senderType: 'user', senderName: 'u', createTimeMs: atMs, text: `text-${id}` };
}

function threadRow(chatId: string, rootId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, chatId, rootMessageId: rootId, scope: 'thread', chatType: 'group', title: `话题-${rootId}`, larkAppId: 'cli_x', ...extra };
}

interface Harness {
  rows: Array<Record<string, unknown>>;
  windows: Map<string, TopicHistoryWindow>;
  modelResponses: Array<{ status: number; body: unknown }>;
  modelCalls: number;
  embedCalls: number;
  config: TopicSearchConfig | null;
  readCalls: number;
}

async function makeRuntime(
  harness: Harness,
  configOverride?: Partial<TopicSearchConfig>,
  forceConfig?: TopicSearchConfig | null,
): Promise<TopicSearchRuntime> {
  const config: TopicSearchConfig = forceConfig === undefined ? { ...baseConfig, ...configOverride } : forceConfig;
  const readHistory: TopicHistoryReader = async identity => {
    harness.readCalls++;
    const key = `${identity.chatId}:${identity.rootMessageId}`;
    return harness.windows.get(key) ?? { messages: [], truncated: false };
  };
  const deps: TopicSearchRuntimeDeps = {
    dataDir: tempDir,
    getConfig: () => config,
    discoverRows: () => harness.rows,
    readHistory,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/embeddings')) {
        harness.embedCalls++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200 });
      }
      harness.modelCalls++;
      const next = harness.modelResponses.shift();
      if (!next) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mutations: [{ op: 'noop' }] }) } }] }), { status: 200 });
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch,
    env: { K: 'sk-test' },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => BASE,
  };
  const runtime = await TopicSearchRuntime.create(deps);
  runtimes.push(runtime);
  return runtime;
}

function chatCompletion(mutations: unknown[]) {
  return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ mutations }) } }] } };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-runtime-test-'));
  runtimes = [];
});

afterEach(async () => {
  await Promise.all(runtimes.map(r => r.stop().catch(() => undefined)));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('发现与准入', () => {
  it('仅授权群的 thread+om_ 会话入目录；chat-scope/p2p/虚拟锚点/未授权群不入', async () => {
    const harness: Harness = { rows: [], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    harness.rows = [
      threadRow('oc_allowed', 'om_r1', 's1'),
      threadRow('oc_allowed', 'om_r1', 's2'),            // 同话题第二 session → 同一目录条目
      threadRow('oc_allowed', 'om_r2', 's3'),            // 第二个话题
      threadRow('oc_allowed', 'om_r3', 's4', { scope: 'chat' }),
      threadRow('oc_allowed', 'om_r4', 's5', { chatType: 'p2p' }),
      threadRow('oc_allowed', 'schedule-task:t1', 's6'), // 虚拟锚点
      threadRow('oc_other', 'om_r5', 's7'),              // 未授权群
    ];
    const runtime = await makeRuntime(harness, { maxTopicsPerRun: 2 });
    const report = await runtime.tick();
    expect(report.discovered).toBe(2); // r1、r2（oc_other 未授权、其余形态不入目录）
    expect(report.topicsProcessed).toBe(2); // maxTopicsPerRun 限流
    const topics = runtime.topicStore.listTopics();
    expect(topics.map(t => t.rootMessageId).sort()).toEqual(['om_r1', 'om_r2']);
  });
});

describe('增量与游标', () => {
  it('有增量 → 提交；同一窗口第二轮 → 零模型调用', async () => {
    const harness: Harness = { rows: [threadRow('oc_allowed', 'om_r1', 's1')], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    harness.windows.set('oc_allowed:om_r1', { messages: [msg('om_1'), msg('om_2')], truncated: false });
    harness.modelResponses.push(chatCompletion([{ op: 'add', text: '事件A', keywords: ['a'], sourceMessageIds: ['om_1', 'om_2'] }]));
    const runtime = await makeRuntime(harness);
    const first = await runtime.tick();
    expect(first).toMatchObject({ ran: true, committed: 1, noIncrement: 0 });
    expect(harness.modelCalls).toBe(1);
    const topic = runtime.topicStore.listTopics()[0];
    expect(topic.summarizedThroughCursor).toBe('msg:om_2');

    const second = await runtime.tick();
    expect(second).toMatchObject({ noIncrement: 1, committed: 0 });
    expect(harness.modelCalls).toBe(1); // 零新增模型调用（A-02）
    expect(runtime.topicStore.listTopics()[0].lastCheckedAt).toBeTruthy();
  });

  it('首轮按回看窗口裁剪，老消息不进增量', async () => {
    const harness: Harness = { rows: [threadRow('oc_allowed', 'om_r1', 's1')], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    harness.windows.set('oc_allowed:om_r1', {
      messages: [msg('om_old1', BASE - 30 * DAY), msg('om_new1', BASE - DAY)],
      truncated: false,
    });
    harness.modelResponses.push(chatCompletion([{ op: 'add', text: '近期事件', keywords: [], sourceMessageIds: ['om_new1'] }]));
    const runtime = await makeRuntime(harness);
    await runtime.tick();
    expect(harness.modelCalls).toBe(1);
    const topic = runtime.topicStore.listTopics()[0];
    expect(topic.summarizedThroughCursor).toBe('msg:om_new1');
    expect(topic.coverageStartAt).toBe(new Date(BASE - DAY).toISOString());
  });
});

describe('公平扫描', () => {
  it('maxTopicsPerRun 限流 + 游标轮转：两轮覆盖全部话题', async () => {
    const harness: Harness = { rows: [
      threadRow('oc_allowed', 'om_r1', 's1'),
      threadRow('oc_allowed', 'om_r2', 's2'),
    ], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    const runtime = await makeRuntime(harness, { maxTopicsPerRun: 1 });
    const first = await runtime.tick();
    expect(first.topicsProcessed).toBe(1);
    const second = await runtime.tick();
    expect(second.topicsProcessed).toBe(1);
    expect(harness.readCalls).toBe(2);
    // 两轮合计读过两个不同话题
    const both = runtime.topicStore.listTopics().map(t => t.lastCheckedAt);
    expect(both.every(Boolean)).toBe(true);
  });
});

describe('失败与重试', () => {
  it('模型失败：游标不动；重试任务退避，下一 tick 不立即重跑', async () => {
    const harness: Harness = { rows: [threadRow('oc_allowed', 'om_r1', 's1')], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    harness.windows.set('oc_allowed:om_r1', { messages: [msg('om_1')], truncated: false });
    // client 对 5xx 自动重试 2 次：3 个 503 保证整轮失败
    harness.modelResponses.push({ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} });
    const runtime = await makeRuntime(harness);
    const first = await runtime.tick();
    expect(first.failed).toBe(1);
    expect(runtime.topicStore.listTopics()[0].summarizedThroughCursor).toBeUndefined();
    expect(harness.modelCalls).toBe(3);

    // 同一时刻的第二个 tick：退避窗口内不认领重试（模型零新增调用）
    harness.modelResponses.push(chatCompletion([{ op: 'noop' }]));
    const second = await runtime.tick();
    expect(second.retried).toBe(0);
    expect(harness.modelCalls).toBe(3);

    // 时间前进超过退避（60s）后再 tick：重试任务被认领并成功（同目录，任务持久）
    const laterRuntime = runtimes[0];
    await laterRuntime.stop();
    runtimes.splice(0);
    const harness2 = harness;
    const runtime3 = await makeRuntimeAt(harness2, BASE + 10 * 60_000, tempDir);
    const third = await runtime3.tick();
    expect(third.retried).toBe(1);
    const job = runtime3.topicStore.getJob('summary-retry:thread:oc_allowed:om_r1');
    expect(job?.state).toBe('done');
    expect(runtime3.topicStore.listTopics()[0].summarizedThroughCursor).toBe('msg:om_1');
  });
});

describe('embedding', () => {
  it('摘要提交后同 tick 生成向量（不拖到下个槽位）', async () => {
    const harness: Harness = { rows: [threadRow('oc_allowed', 'om_r1', 's1')], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: null, readCalls: 0 };
    harness.windows.set('oc_allowed:om_r1', { messages: [msg('om_1')], truncated: false });
    harness.modelResponses.push(chatCompletion([{ op: 'add', text: '要向量化的摘要', keywords: [], sourceMessageIds: ['om_1'] }]));
    const runtime = await makeRuntime(harness, {
      embedding: { enabled: true, model: { provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', model: 'emb-1', dimensions: 4 } },
    });
    const report = await runtime.tick();
    expect(report.committed).toBe(1);
    expect(report.embeddingsProcessed).toBe(1);
    expect(harness.embedCalls).toBe(1);
    const topic = runtime.topicStore.listTopics()[0];
    expect(topic.summaries[0].embedding?.modelKey).toBe('openai-compatible/emb-1:4');
  });
});

describe('停用与租约', () => {
  it('中途停用：读取后禁用，模型调用前熔断', async () => {
    const h2: Harness = { rows: [threadRow('oc_allowed', 'om_r1', 's1')], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    h2.windows.set('oc_allowed:om_r1', { messages: [msg('om_1')], truncated: false });
    h2.modelResponses.push(chatCompletion([{ op: 'noop' }]));
    const flippingRuntime = await makeRuntimeFlipping(h2);
    const report = await flippingRuntime.tick();
    expect(report.ran).toBe(true);
    expect(h2.modelCalls).toBe(0); // 停用后零模型调用
  });

  it('部署级租约：同库第二个实例的 tick 被拒（单飞）', async () => {
    const harness: Harness = { rows: [], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: baseConfig, readCalls: 0 };
    const first = await makeRuntime(harness);
    const second = await makeRuntime({ ...harness });
    const r1 = first.tick();
    const r2 = await second.tick();
    expect((await r1).ran).toBe(true);
    expect(r2).toMatchObject({ ran: false, reason: 'lease_held' });
  });

  it('getConfig 为 null（功能关闭）：tick 直接不运行', async () => {
    const harness: Harness = { rows: [], windows: new Map(), modelResponses: [], modelCalls: 0, embedCalls: 0, config: null, readCalls: 0 };
    const runtime = await makeRuntime(harness, undefined, null);
    const report = await runtime.tick();
    expect(report).toMatchObject({ ran: false, reason: 'disabled' });
  });
});

// ─── helpers for time-shifted / flipping runtimes ───────────────────────────

async function makeRuntimeAt(harness: Harness, nowMs: number, dir: string): Promise<TopicSearchRuntime> {
  const readHistory: TopicHistoryReader = async identity => {
    harness.readCalls++;
    const key = `${identity.chatId}:${identity.rootMessageId}`;
    return harness.windows.get(key) ?? { messages: [], truncated: false };
  };
  const runtime = await TopicSearchRuntime.create({
    dataDir: dir,
    getConfig: () => harness.config,
    discoverRows: () => harness.rows,
    readHistory,
    fetchImpl: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('/embeddings')) {
        harness.embedCalls++;
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200 });
      }
      harness.modelCalls++;
      const next = harness.modelResponses.shift();
      if (!next) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mutations: [{ op: 'noop' }] }) } }] }), { status: 200 });
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch,
    env: { K: 'sk-test' },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => nowMs,
  });
  runtimes.push(runtime);
  return runtime;
}

async function makeRuntimeFlipping(harness: Harness): Promise<TopicSearchRuntime> {
  const readHistory: TopicHistoryReader = async identity => {
    // 第一次读取成功后立即停用功能（模拟运行边界上的禁用）
    harness.config = null;
    const key = `${identity.chatId}:${identity.rootMessageId}`;
    return harness.windows.get(key) ?? { messages: [], truncated: false };
  };
  const runtime = await TopicSearchRuntime.create({
    dataDir: tempDir,
    getConfig: () => harness.config,
    discoverRows: () => harness.rows,
    readHistory,
    fetchImpl: (async (url: string | URL | Request) => {
      harness.modelCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mutations: [{ op: 'noop' }] }) } }] }), { status: 200 });
    }) as typeof fetch,
    env: { K: 'sk-test' },
    logger: { info: () => undefined, warn: () => undefined },
    now: () => BASE,
  });
  runtimes.push(runtime);
  return runtime;
}
