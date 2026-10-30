/** 复测确认问题的正式回归（change.md 复测报告四项，探针已转正确行为断言）：
 *  1. CAS 绑定模型输入快照 revision：双 SQLite 连接下，模型等待期间他方提交，
 *     旧 mutations 绝不借新 revision 落库，游标绝不回退
 *  2. 有界读取连续性：reader 回溯到成功游标才算连续增量；「窗口比游标新」不是
 *     证明——gap 永不被跳过；多轮批上限内全量追平
 *  3. topicCreatedAt 只接受被证实的根消息时间；截断窗口最早回复不冒充
 *  4. UI 日历日（YYYY-MM-DD）按明确时区展开为完整日边界；完整 ISO 直通
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TopicStore } from '../src/topic/store.js';
import { updateTopicFromWindow } from '../src/topic/summary-updater.js';
import type { SourceMessage, TopicHistoryWindow } from '../src/topic/source.js';
import { collectThreadMessageScan } from '../src/im/lark/client.js';
import { expandTopicSearchDateFilters } from '../src/dashboard/topic-search-api.js';

const T0 = '2026-10-29T00:00:00.000Z';
const BASE = Date.parse(T0);

let tempDir: string;
let store: TopicStore;

function m(id: string, atMs = BASE): SourceMessage {
  return { messageId: id, senderType: 'user', senderName: 'u', createTimeMs: atMs, text: `text-${id}` };
}

function deps(callModel: (input: any) => Promise<any>) {
  return { store, callModel, now: () => T0 };
}

function add(text: string, id: string) {
  return { op: 'add' as const, text, keywords: [], sourceMessageIds: [id] };
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-retest-'));
  store = await TopicStore.open(tempDir);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seed() {
  return store.ensureTopic({
    topicKey: 'thread:oc_a:om_root', chatId: 'oc_a', rootMessageId: 'om_root',
    title: 'test', accessPolicyRef: 'chat:oc_a',
  }, T0).topic;
}

describe('复测1：CAS 快照绑定（双连接并发）', () => {
  it('A 等待模型期间 B 提交到 om_2：A 的旧结果不落库、游标停在 om_2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topic-retest-cas-'));
    const a = await TopicStore.open(dir);
    const b = await TopicStore.open(dir);
    try {
      const topic = a.ensureTopic({
        topicKey: 'thread:oc_a:om_root', chatId: 'oc_a', rootMessageId: 'om_root',
        title: 'test', accessPolicyRef: 'chat:oc_a',
      }, T0).topic;
      const result = await updateTopicFromWindow({
        store: a,
        now: () => T0,
        callModel: async () => {
          b.commitSummaryUpdate({
            topicKey: topic.topicKey, expectedRevision: b.getTopic(topic.topicKey)!.revision,
            mutations: [add('winner', 'om_2')], generatorKey: 'test',
            now: T0, summarizedThroughCursor: 'msg:om_2', sourceThroughAt: new Date(BASE + 1000).toISOString(),
          });
          return { ok: true, mutations: [add('stale', 'om_1')], generatorKey: 'test' };
        },
      }, { topicKey: topic.topicKey, window: { messages: [m('om_1')], truncated: false } });
      const final = a.getTopic(topic.topicKey)!;
      expect(result.kind).not.toBe('committed');
      expect(final.summaries.map(s => s.text)).toEqual(['winner']);
      expect(final.summarizedThroughCursor).toBe('msg:om_2');
    } finally {
      a.close(); b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('复测第二轮1：重生成分支的 revision 绑定', () => {
  it('第二次模型等待期间再冲突：不借最新 revision，二次冲突退出、游标不回退', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'topic-retest-cas2-'));
    const a = await TopicStore.open(dir);
    const b = await TopicStore.open(dir);
    try {
      const topic = a.ensureTopic({
        topicKey: 'thread:oc_a:om_root', chatId: 'oc_a', rootMessageId: 'om_root',
        title: 'test', accessPolicyRef: 'chat:oc_a',
      }, T0).topic;
      let modelCalls = 0;
      const result = await updateTopicFromWindow({
        store: a, now: () => T0,
        callModel: async () => {
          modelCalls++;
          if (modelCalls === 1) {
            // 第一次等待：B 提交 M1（cursor om_1）→ A 首次提交冲突、触发重生成
            b.commitSummaryUpdate({
              topicKey: topic.topicKey, expectedRevision: b.getTopic(topic.topicKey)!.revision,
              mutations: [add('winner1', 'om_1')], generatorKey: 'test',
              now: T0, summarizedThroughCursor: 'msg:om_1',
            });
            return { ok: true, mutations: [add('stale1', 'om_1')], generatorKey: 'test' };
          }
          // 第二次等待（重生成 [om_2] 期间）：B 再提交 M2 → 重生成结果此刻已过期
          b.commitSummaryUpdate({
            topicKey: topic.topicKey, expectedRevision: b.getTopic(topic.topicKey)!.revision,
            mutations: [add('winner2', 'om_2')], generatorKey: 'test',
            now: T0, summarizedThroughCursor: 'msg:om_2',
          });
          return { ok: true, mutations: [add('regen', 'om_2')], generatorKey: 'test' };
        },
      }, { topicKey: topic.topicKey, window: { messages: [m('om_1'), m('om_2')], truncated: false } }, { firstRunSinceMs: BASE - 1 });
      expect(result).toMatchObject({ kind: 'commit_conflict' });
      expect(modelCalls).toBe(2);
      const final = a.getTopic(topic.topicKey)!;
      expect(final.summaries.map(s => s.text)).toEqual(['winner1', 'winner2']); // 无 stale/regen 落库
      expect(final.summarizedThroughCursor).toBe('msg:om_2'); // 游标停在胜者位置，绝不回退
    } finally {
      a.close(); b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('复测2：有界读取的连续性证明', () => {
  it('旧游标 om_100、尾部窗口 om_301..500 且无连续证明：不推进，gap 永不跳过', async () => {
    const topic = seed();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: topic.revision,
      mutations: [{ op: 'noop' }], generatorKey: 'test',
      now: T0, summarizedThroughCursor: 'msg:om_100', sourceThroughAt: new Date(BASE + 100).toISOString(),
    });
    const seen: string[] = [];
    const window: TopicHistoryWindow = {
      messages: Array.from({ length: 200 }, (_, i) => m(`om_${i + 301}`, BASE + i + 301)),
      truncated: true,
      cursorFound: false, // reader 预算内没回溯到 om_100
    };
    for (let round = 0; round < 2; round++) {
      const outcome = await updateTopicFromWindow(deps(async input => {
        seen.push(...input.newMessages.map((x: any) => x.messageId));
        return { ok: true, mutations: [{ op: 'noop' }], generatorKey: 'test' };
      }), { topicKey: topic.topicKey, window });
      expect(outcome).toMatchObject({ kind: 'no_increment', skippedReason: 'cursor_beyond_window' });
    }
    const final = store.getTopic(topic.topicKey)!;
    expect(final.summarizedThroughCursor).toBe('msg:om_100'); // 两轮都不推进
    expect(seen).toHaveLength(0); // om_101..om_300 从未进入模型
  });

  it('reader 按游标回溯（untilMessageId）：多轮批上限内追平全部 300 条新增，无跳过', async () => {
    const topic = seed();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: topic.revision,
      mutations: [{ op: 'noop' }], generatorKey: 'test',
      now: T0, summarizedThroughCursor: 'msg:om_100', sourceThroughAt: new Date(BASE).toISOString(),
    });
    const all = Array.from({ length: 400 }, (_, i) => m(`om_${i + 1}`, BASE + i + 1));
    const seen: string[] = [];
    // 模拟 listThreadMessagesUntil：从游标回溯，返回其后连续块
    const readerWindow = (until: string | undefined): TopicHistoryWindow => {
      if (!until) return { messages: all.slice(100), truncated: false, cursorFound: true };
      const index = all.findIndex(x => x.messageId === until);
      return {
        messages: index >= 0 ? all.slice(index + 1) : [],
        truncated: false,
        cursorFound: index >= 0,
      };
    };
    for (let round = 0; round < 5; round++) {
      const cursor = store.getTopic(topic.topicKey)!.summarizedThroughCursor;
      const until = cursor?.startsWith('msg:') ? cursor.slice(4) : undefined;
      const outcome = await updateTopicFromWindow(deps(async input => {
        seen.push(...input.newMessages.map((x: any) => x.messageId));
        return { ok: true, mutations: [{ op: 'noop' }], generatorKey: 'test' };
      }), { topicKey: topic.topicKey, window: readerWindow(until) });
      if (outcome.kind === 'no_increment') break;
    }
    const final = store.getTopic(topic.topicKey)!;
    expect(final.summarizedThroughCursor).toBe('msg:om_400');
    expect(seen).toHaveLength(300); // om_101..om_400 全部处理，零跳过
    expect(seen[0]).toBe('om_101');
    expect(seen[299]).toBe('om_400');
  });
});

describe('复测3：topicCreatedAt 只认被证实的根消息时间', () => {
  it('截断窗口（3 日回复）不冒充创建时间：无 rootCreatedAtMs → 保持 unknown', async () => {
    const topic = seed();
    await updateTopicFromWindow(deps(async () => ({ ok: true, mutations: [{ op: 'noop' }], generatorKey: 'test' })), {
      topicKey: topic.topicKey,
      window: { messages: [m('om_1', BASE + 2 * 24 * 3600_000 + 12 * 3600_000)], truncated: true },
    });
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.topicCreatedAt).toBeUndefined(); // 不拿窗口最早回复伪装
    expect(stored.latestMessageAt).toBe(new Date(BASE + 2 * 24 * 3600_000 + 12 * 3600_000).toISOString());
  });

  it('带 rootCreatedAtMs（真实 1 日）：创建口径可命中 1–2 日', async () => {
    const topic = seed();
    const rootAt = BASE + 12 * 3600_000; // 1 日中午
    await updateTopicFromWindow(deps(async () => ({ ok: true, mutations: [{ op: 'noop' }], generatorKey: 'test' })), {
      topicKey: topic.topicKey,
      window: {
        messages: [m('om_1', BASE + 2 * 24 * 3600_000 + 12 * 3600_000)], // 窗口最早是 3 日回复
        truncated: true,
        rootCreatedAtMs: rootAt,
      },
    });
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.topicCreatedAt).toBe(new Date(rootAt).toISOString()); // 用被证实的根时间
    expect(stored.topicCreatedAt).not.toBe(stored.latestMessageAt);
  });
});

describe('复测第三轮：真实 reader 扫描核心 → updater（游标消息被引用的摘要保留）', () => {
  // 与 daemon 路由同形的原始消息（新→旧分页），经 collectThreadMessageScan
  // （真实 reader 核心）产出窗口，再交真实 updater——不手工构造 historyIds。
  const raw = (id: string, atMs: number) => ({ message_id: id, create_time: String(atMs), body: { content: `{"text":"t-${id}"}` }, sender: { id: 'ou_x', sender_type: 'user' } });
  async function* pagesOf(items: any[][]): AsyncGenerator<any[]> {
    for (const page of items) yield page;
  }
  const T = Date.parse('2026-10-29T00:00:00Z');

  it('有增量：线程 [M1,M2]、游标 M1、旧摘要引用 M1 → 摘要保留、M2 正常提交', async () => {
    const topic = seed();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '引用 M1 的旧摘要', keywords: [], sourceMessageIds: ['om_1'] }],
      generatorKey: 'g', now: T0, summarizedThroughCursor: 'msg:om_1', sourceThroughAt: T0,
    });
    // Lark 分页新→旧：先 M2 页再 M1 页（M1 即游标，本身仍在线程里）
    const scan = await collectThreadMessageScan(pagesOf([[raw('om_2', T + 2000)], [raw('om_1', T + 1000)]]), {
      untilMessageId: 'om_1', tailCap: 200, maxScan: 2000,
    });
    expect(scan.cursorFound).toBe(true);
    expect(scan.reachedOldest).toBe(true);
    expect(scan.historyIds).toContain('om_1'); // 游标消息本身在覆盖集合里
    const outcome = await updateTopicFromWindow(deps(async () => ({ ok: true, mutations: [{ op: 'add', text: 'M2 事件', keywords: [], sourceMessageIds: ['om_2'] }], generatorKey: 'g' })), {
      topicKey: topic.topicKey,
      window: {
        messages: scan.messages.map(m => ({ messageId: m.message_id, createTimeMs: Number(m.create_time), text: 't' })),
        truncated: false, cursorFound: scan.cursorFound, reachedOldest: scan.reachedOldest, historyIds: scan.historyIds,
      },
    });
    expect(outcome).toMatchObject({ kind: 'committed' });
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries.map(s => s.text)).toEqual(['引用 M1 的旧摘要', 'M2 事件']); // 旧摘要保留
    expect(stored.summarizedThroughCursor).toBe('msg:om_2');
  });

  it('无增量：线程仅 [M1]（=游标）、旧摘要引用 M1 → 空增量，摘要保留不失效', async () => {
    const topic = seed();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '引用 M1 的旧摘要', keywords: [], sourceMessageIds: ['om_1'] }],
      generatorKey: 'g', now: T0, summarizedThroughCursor: 'msg:om_1', sourceThroughAt: T0,
    });
    const scan = await collectThreadMessageScan(pagesOf([[raw('om_1', T + 1000)]]), {
      untilMessageId: 'om_1', tailCap: 200, maxScan: 2000,
    });
    expect(scan.messages).toEqual([]);
    expect(scan.historyIds).toEqual(['om_1']);
    let modelCalls = 0;
    const outcome = await updateTopicFromWindow(deps(async () => { modelCalls++; return { ok: true, mutations: [{ op: 'noop' }], generatorKey: 'g' }; }), {
      topicKey: topic.topicKey,
      window: {
        messages: [], truncated: false, cursorFound: scan.cursorFound, reachedOldest: scan.reachedOldest, historyIds: scan.historyIds,
      },
    });
    expect(outcome).toMatchObject({ kind: 'no_increment' });
    expect(modelCalls).toBe(0);
    expect(store.getTopic(topic.topicKey)!.summaries).toHaveLength(1); // 引用游标消息的摘要保留
  });
});

describe('复测4：日历日按明确时区展开为完整日边界', () => {
  it('同日筛选覆盖全天（含中午消息）；展开使用所选时区', () => {
    const zone = 'Asia/Shanghai';
    const expanded = expandTopicSearchDateFilters({ timeBasis: 'latestMessage', from: '2026-10-03', to: '2026-10-03' }, zone);
    // 上海 3 日 00:00 = 前一日 16:00Z；3 日 23:59:59.999 = 3 日 15:59:59.999Z
    expect(expanded.from).toBe('2026-10-02T16:00:00.000Z');
    expect(expanded.to).toBe('2026-10-03T15:59:59.999Z');
    // 3 日中午（UTC）消息在范围内
    const noon = Date.parse('2026-10-03T12:00:00Z');
    expect(noon >= Date.parse(expanded.from!) && noon <= Date.parse(expanded.to!)).toBe(true);
  });

  it('完整 ISO 直通；垃圾值被丢弃；UTC 时区为零偏移', () => {
    const expanded = expandTopicSearchDateFilters({
      from: '2026-10-03T08:00:00Z', to: 'not-a-date',
    }, 'UTC');
    expect(expanded.from).toBe('2026-10-03T08:00:00Z');
    expect(expanded.to).toBeUndefined();
    const utcDay = expandTopicSearchDateFilters({ from: '2026-10-03' }, 'UTC');
    expect(utcDay.from).toBe('2026-10-03T00:00:00.000Z');
  });
});
