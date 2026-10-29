import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTopicStore, topicStorePath, type TopicStore } from '../src/topic/store.js';
import { summaryContentHash } from '../src/topic/vector.js';

let dir: string;
let store: TopicStore;

function addTopic(now = '2026-10-01T00:00:00.000Z'): void {
  store.upsertTopicDirectory({
    topicKey: 'thread:oc_1:om_1',
    chatId: 'oc_1',
    rootMessageId: 'om_1',
    title: '跨 bot owner 校验',
    accessPolicyRef: 'deployment:topic-search',
    now,
    coverageStartAt: now,
  });
}

function addSummary(text = '第一条摘要') {
  return store.commitSummaryMutation({
    topicKey: 'thread:oc_1:om_1',
    expectedRevision: store.getTopic('thread:oc_1:om_1')!.revision,
    mutations: [{ op: 'add', text, keywords: ['owner'], sourceMessageIds: ['om_100'] }],
    nextCursor: 'cursor-1',
    sourceThroughAt: '2026-10-01T01:00:00.000Z',
    generatorKey: 'test-model@v1',
    now: '2026-10-01T01:00:00.000Z',
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-store-test-'));
  store = openTopicStore({ path: join(dir, 'topics.sqlite') });
  addTopic();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Topic 存储', () => {
  it('默认库路径落在数据目录下（不是编译虚拟目录）', () => {
    expect(topicStorePath('/tmp/data')).toBe('/tmp/data/topic-search.sqlite');
  });

  it('目录刷新只更新元数据，不回退摘要与游标', () => {
    addSummary('已有摘要');
    store.recordCheck({ topicKey: 'thread:oc_1:om_1', checkedAt: '2026-10-02T00:00:00.000Z' });
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: '改过的标题',
      accessPolicyRef: 'deployment:topic-search',
      now: '2026-10-03T00:00:00.000Z',
    });
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.title).toBe('改过的标题');
    expect(topic.summaries).toHaveLength(1);
    expect(topic.summarizedThroughCursor).toBe('cursor-1');
    expect(topic.revision).toBe(1);
    expect(topic.lastCheckedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('revision CAS：过期的 expectedRevision 不覆盖，只回报当前版本', () => {
    addSummary('第一条');
    const first = store.getTopic('thread:oc_1:om_1')!;
    // 用旧 revision 再提交一次：必须 conflict，而不是覆盖。
    const conflict = store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '并发写入', keywords: [], sourceMessageIds: ['om_101'] }],
      nextCursor: 'cursor-stale',
      sourceThroughAt: '2026-10-01T02:00:00.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T02:00:00.000Z',
    });
    expect(conflict).toEqual({ status: 'conflict', revision: first.revision });
    const after = store.getTopic('thread:oc_1:om_1')!;
    expect(after.summaries).toHaveLength(1);
    expect(after.summarizedThroughCursor).toBe('cursor-1');
  });

  it('noop 也推进游标（代表本批处理成功）', () => {
    const before = store.getTopic('thread:oc_1:om_1')!;
    const result = store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: before.revision,
      mutations: [{ op: 'noop' }],
      nextCursor: 'cursor-noop',
      sourceThroughAt: '2026-10-01T05:00:00.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T05:00:00.000Z',
    });
    expect(result.status).toBe('committed');
    expect(store.getTopic('thread:oc_1:om_1')!.summarizedThroughCursor).toBe('cursor-noop');
  });

  it('update 改正文后旧向量立即不可用；同正文写入的迟到向量被丢弃', () => {
    addSummary('原始正文');
    const summary = store.getTopic('thread:oc_1:om_1')!.summaries[0];
    expect(
      store.markSummaryEmbedding({
        topicKey: 'thread:oc_1:om_1',
        summaryId: summary.id,
        modelKey: 'host/model/8',
        contentHash: summaryContentHash('原始正文'),
        vector: [1, 0, 0],
        now: '2026-10-01T03:00:00.000Z',
      }),
    ).toBe(true);
    expect(store.getTopic('thread:oc_1:om_1')!.summaries[0].embedding?.vector).toEqual([1, 0, 0]);

    const topic = store.getTopic('thread:oc_1:om_1')!;
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: topic.revision,
      mutations: [
        { op: 'update', id: summary.id, text: '改写后的正文', keywords: ['owner'], sourceMessageIds: ['om_102'] },
      ],
      nextCursor: 'cursor-2',
      sourceThroughAt: '2026-10-01T04:00:00.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T04:00:00.000Z',
    });
    expect(store.getTopic('thread:oc_1:om_1')!.summaries[0].embedding).toBeUndefined();

    // 迟到的旧正文向量：hash 不匹配 → 丢弃（返回 false），不写进库。
    expect(
      store.markSummaryEmbedding({
        topicKey: 'thread:oc_1:om_1',
        summaryId: summary.id,
        modelKey: 'host/model/8',
        contentHash: summaryContentHash('原始正文'),
        vector: [0, 1, 0],
        now: '2026-10-01T05:00:00.000Z',
      }),
    ).toBe(false);
    expect(store.getTopic('thread:oc_1:om_1')!.summaries[0].embedding).toBeUndefined();
  });

  it('待回填向量任务只包含「无向量或正文已变」的摘要', () => {
    addSummary('A');
    const topic = store.getTopic('thread:oc_1:om_1')!;
    const summary = topic.summaries[0];
    store.markSummaryEmbedding({
      topicKey: 'thread:oc_1:om_1',
      summaryId: summary.id,
      modelKey: 'host/model/8',
      contentHash: summaryContentHash('A'),
      vector: [1],
      now: '2026-10-01T03:00:00.000Z',
    });
    expect(store.pendingEmbeddingTasks(10)).toEqual([]);

    const fresh = store.getTopic('thread:oc_1:om_1')!;
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: fresh.revision,
      mutations: [
        { op: 'update', id: summary.id, text: 'B', keywords: [], sourceMessageIds: ['om_103'] },
      ],
      nextCursor: 'cursor-3',
      sourceThroughAt: '2026-10-01T06:00:00.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T06:00:00.000Z',
    });
    expect(store.pendingEmbeddingTasks(10).map(task => task.text)).toEqual(['B']);
  });

  it('槽位租约：同一槽位只有一个 owner，过期后可被接管，完成后不再重复', () => {
    const first = store.acquireSlot({
      slotId: 'slot-1',
      owner: 'owner-a',
      now: '2026-10-01T00:00:00.000Z',
      leaseMs: 60_000,
    });
    expect(first).toEqual({ acquired: true, mode: 'new' });
    expect(
      store.acquireSlot({ slotId: 'slot-1', owner: 'owner-b', now: '2026-10-01T00:00:30.000Z', leaseMs: 60_000 }),
    ).toEqual({ acquired: false, reason: 'lease_held' });

    // 租约到期：崩掉的 owner 不再阻塞（接管，而不是永久卡死）。
    expect(
      store.acquireSlot({ slotId: 'slot-1', owner: 'owner-b', now: '2026-10-01T00:02:00.000Z', leaseMs: 60_000 }),
    ).toEqual({ acquired: true, mode: 'taken_over' });

    // 只有当前 owner 能结算。
    expect(
      store.finishSlot({ slotId: 'slot-1', owner: 'owner-a', status: 'ok', now: '2026-10-01T00:03:00.000Z' }),
    ).toBe(false);
    expect(
      store.finishSlot({ slotId: 'slot-1', owner: 'owner-b', status: 'ok', now: '2026-10-01T00:03:00.000Z' }),
    ).toBe(true);
    expect(
      store.acquireSlot({ slotId: 'slot-1', owner: 'owner-c', now: '2026-10-01T05:00:00.000Z', leaseMs: 60_000 }),
    ).toEqual({ acquired: false, reason: 'already_finished' });
  });

  it('下一次计划时刻持久化，重开库后仍在（重启不能忘）', () => {
    store.setNextRunAt('2026-10-02T02:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(store.getNextRunAt()).toBe('2026-10-02T02:00:00.000Z');
    store.close();
    store = openTopicStore({ path: join(dir, 'topics.sqlite') });
    expect(store.getNextRunAt()).toBe('2026-10-02T02:00:00.000Z');
    expect(store.getTopic('thread:oc_1:om_1')).not.toBeNull();
  });

  it('源侧确认删除某条消息时失效引用它的摘要与向量，游标不动', () => {
    const commit = addSummary('引用了 om_100 的摘要');
    const summary = commit.status === 'committed' ? commit.summaries[0] : null;
    expect(summary).not.toBeNull();
    store.markSummaryEmbedding({
      topicKey: 'thread:oc_1:om_1',
      summaryId: summary!.id,
      modelKey: 'test-model@v1',
      contentHash: summaryContentHash(summary!.text),
      vector: [1, 0, 0],
      now: '2026-10-01T01:05:00.000Z',
    });
    const before = store.getTopic('thread:oc_1:om_1')!;
    expect(before.summaries[0].embedding).toBeTruthy();

    const result = store.invalidateSummariesForMessages({
      topicKey: 'thread:oc_1:om_1',
      messageIds: ['om_100'],
      now: '2026-10-02T00:00:00.000Z',
    });

    expect(result.invalidated).toBe(1);
    expect(result.revision).toBe(before.revision + 1);
    const after = store.getTopic('thread:oc_1:om_1')!;
    expect(after.summaries).toEqual([]);
    // 游标必须保持原位置：失效不是「这批消息处理成功」。
    expect(after.summarizedThroughCursor).toBe(before.summarizedThroughCursor);
    // 向量任务也不能再把它当成待回填项。
    expect(store.pendingEmbeddingTasks(10)).toEqual([]);
  });

  it('没有摘要引用被删消息时不递增 revision，避免无谓 CAS 冲突', () => {
    addSummary('引用 om_100');
    const before = store.getTopic('thread:oc_1:om_1')!;
    const result = store.invalidateSummariesForMessages({
      topicKey: 'thread:oc_1:om_1',
      messageIds: ['om_other'],
      now: '2026-10-02T00:00:00.000Z',
    });
    expect(result).toEqual({ invalidated: 0, revision: before.revision });
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);
  });

  it('删除话题连带删摘要与向量，不动其它话题', () => {
    addTopic('2026-10-01T00:00:00.000Z');
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_2:om_2',
      chatId: 'oc_2',
      rootMessageId: 'om_2',
      title: '另一个话题',
      accessPolicyRef: 'deployment:topic-search',
      now: '2026-10-01T00:00:00.000Z',
    });
    addSummary();
    store.deleteTopic('thread:oc_1:om_1');
    expect(store.getTopic('thread:oc_1:om_1')).toBeNull();
    expect(store.getTopic('thread:oc_2:om_2')).not.toBeNull();
  });
});
