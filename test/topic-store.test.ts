/** Topic 知识库存储层的行为回归（spec 20261028-topic-search §3.1/§5）：
 *  - 目录 ensure 幂等：刷新快照不丢摘要/游标/revision（关闭 session 保留话题）
 *  - 摘要提交 revision CAS：冲突不覆盖、批内校验失败全量回滚（游标不动）
 *  - 游标语义：recordHistoryCheck 只动 lastCheckedAt
 *  - 向量：内容变更同事务失效旧向量 + 入队；迟到向量按 contentHash 丢弃
 *  - 任务：幂等键、租约认领、退避重试、耗尽转 dead、租约过期回收
 *  - 部署级租约 CAS 与重启持久性（待处理任务不遗忘）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  TopicStore,
  TopicRevisionConflictError,
  TopicMutationValidationError,
  computeSummaryContentHash,
  jobRetryDelayMs,
  type SummaryMutation,
} from '../src/topic/store.js';

let tempDir: string;
const T0 = '2026-10-29T00:00:00.000Z';
const T1 = '2026-10-29T01:00:00.000Z';
const T2 = '2026-10-29T02:00:00.000Z';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-store-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function openStore(): Promise<TopicStore> {
  return TopicStore.open(tempDir);
}

function seededTopic(store: TopicStore) {
  return store.ensureTopic({
    topicKey: 'thread:oc_a:om_root1',
    chatId: 'oc_a',
    rootMessageId: 'om_root1',
    title: '话题一',
    accessPolicyRef: 'chat:oc_a',
  }, T0).topic;
}

describe('目录 ensure 与持久性', () => {
  it('新建目录 entry；重复 ensure 刷新标题但不丢知识、不动 revision', async () => {
    const store = await openStore();
    const first = store.ensureTopic({ topicKey: 'thread:oc_a:om_root1', chatId: 'oc_a', rootMessageId: 'om_root1', title: '旧标题', accessPolicyRef: 'chat:oc_a' }, T0);
    expect(first.created).toBe(true);

    const committed = store.commitSummaryUpdate({
      topicKey: 'thread:oc_a:om_root1',
      expectedRevision: first.topic.revision,
      mutations: [{ op: 'add', text: '初始摘要', keywords: ['k'], sourceMessageIds: ['om_1'] }],
      generatorKey: 'test-model/v1',
      now: T1,
      summarizedThroughCursor: 'om_1',
    });
    expect(committed.summaries).toHaveLength(1);
    expect(committed.summarizedThroughCursor).toBe('om_1');

    const again = store.ensureTopic({ topicKey: 'thread:oc_a:om_root1', chatId: 'oc_a', rootMessageId: 'om_root1', title: '新标题', accessPolicyRef: 'chat:oc_a' }, T2);
    expect(again.created).toBe(false);
    expect(again.topic.title).toBe('新标题');
    expect(again.topic.summaries).toHaveLength(1);
    expect(again.topic.summarizedThroughCursor).toBe('om_1');
    expect(again.topic.revision).toBe(committed.revision);
    store.close();
  });

  it('身份不一致的 ensure 被拒绝（同 topicKey 换锚点）', async () => {
    const store = await openStore();
    seededTopic(store);
    expect(() => store.ensureTopic({ topicKey: 'thread:oc_a:om_root1', chatId: 'oc_a', rootMessageId: 'om_OTHER', title: 'x', accessPolicyRef: 'chat:oc_a' }, T1))
      .toThrow(TopicMutationValidationError);
    store.close();
  });

  it('重启后 topics/游标/任务/调度状态全部保留（待处理任务不遗忘）', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '摘要A', keywords: ['a'], sourceMessageIds: ['om_1'] }],
      generatorKey: 'm/v1',
      now: T1,
      summarizedThroughCursor: 'om_5',
      embeddingModelKey: 'emb/v1',
    });
    expect(store.getJob(`embedding:${topic.topicKey}:${committed.summaries[0].id}:${computeSummaryContentHash('摘要A')}`)?.state).toBe('pending');
    store.setScheduleState('scan_cursor', { lastTopicKey: topic.topicKey }, T1);
    store.close();

    const reopened = await openStore();
    const restored = reopened.getTopic(topic.topicKey);
    expect(restored?.summaries).toHaveLength(1);
    expect(restored?.summarizedThroughCursor).toBe('om_5');
    expect(restored?.revision).toBe(committed.revision);
    expect(reopened.getScheduleState<{ lastTopicKey: string }>('scan_cursor')?.lastTopicKey).toBe(topic.topicKey);
    const jobs = reopened.claimDueJobs({ now: T2, owner: reopened.owner, leaseTtlMs: 60_000, limit: 10 });
    expect(jobs.map(j => j.kind)).toEqual(['embedding']);
    reopened.close();
  });

  it('schema version 超前时拒绝打开（降级保护）', async () => {
    {
      const store = await openStore();
      seededTopic(store);
      store.close();
    }
    const db = new DatabaseSync(join(tempDir, 'topic-search.sqlite'));
    db.exec('PRAGMA user_version=99;');
    db.close();
    await expect(openStore()).rejects.toThrow(/topic_store_schema_newer/);
  });

  it('全新库 user_version=1', async () => {
    const store = await openStore();
    expect(store.schemaVersion()).toBe(1);
    store.close();
  });
});

describe('摘要提交（revision CAS）', () => {
  it('add/update/noop 全走通：游标推进、revision+1、向量任务同事务入队', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const added = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '第一批事件', keywords: ['部署'], sourceMessageIds: ['om_1', 'om_2'] }],
      generatorKey: 'm/v1',
      now: T1,
      summarizedThroughCursor: 'om_2',
      embeddingModelKey: 'emb/v1',
    });
    const summaryId = added.summaries[0].id;
    const updated = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: added.revision,
      mutations: [
        { op: 'update', id: summaryId, text: '第一批事件（补充）', keywords: ['部署', '回滚'], sourceMessageIds: ['om_1', 'om_2', 'om_3'] },
        { op: 'noop' },
      ],
      generatorKey: 'm/v1',
      now: T2,
      summarizedThroughCursor: 'om_3',
      sourceThroughAt: T2,
      embeddingModelKey: 'emb/v1',
    });
    expect(updated.summaries).toHaveLength(1);
    expect(updated.summaries[0].text).toBe('第一批事件（补充）');
    expect(updated.summaries[0].keywords).toEqual(['部署', '回滚']);
    expect(updated.summarizedThroughCursor).toBe('om_3');
    expect(updated.revision).toBe(added.revision + 1);
    // 两次内容变化各入队一个 embedding 任务（不同 contentHash）
    const jobs = store.claimDueJobs({ now: T2, owner: 'w', leaseTtlMs: 1000, limit: 10, kinds: ['embedding'] });
    expect(jobs).toHaveLength(2);
    const hashes = new Set(jobs.map(j => (j.payload as { contentHash: string }).contentHash));
    expect(hashes.has(computeSummaryContentHash('第一批事件'))).toBe(true);
    expect(hashes.has(computeSummaryContentHash('第一批事件（补充）'))).toBe(true);
    store.close();
  });

  it('CAS 冲突：旧 revision 提交被拒，现有数据不被覆盖', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: 'A', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T1,
    });
    expect(() => store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision, // 故意用旧 revision
      mutations: [{ op: 'add', text: 'B', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T2,
      summarizedThroughCursor: 'om_99',
    })).toThrow(TopicRevisionConflictError);
    const after = store.getTopic(topic.topicKey)!;
    expect(after.summaries.map(s => s.text)).toEqual(['A']);
    expect(after.revision).toBe(committed.revision);
    expect(after.summarizedThroughCursor).toBeUndefined();
    store.close();
  });

  it('批内校验失败全量回滚：未知 summary id / 空文本 / 重复操作都不落库、游标不动', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: '已有摘要', keywords: ['k'], sourceMessageIds: ['om_1'] }],
      generatorKey: 'm/v1',
      now: T1,
      summarizedThroughCursor: 'om_1',
    });
    const knownId = committed.summaries[0].id;

    const badBatches: SummaryMutation[][] = [
      // 未知 id 的 update
      [{ op: 'add', text: '新', keywords: [], sourceMessageIds: [] }, { op: 'update', id: 'ts_unknown', text: 'x', keywords: [], sourceMessageIds: [] }],
      // 空文本
      [{ op: 'add', text: '   ', keywords: [], sourceMessageIds: [] }],
      // 同一批重复 update 同一 id
      [
        { op: 'update', id: knownId, text: 'x', keywords: [], sourceMessageIds: [] },
        { op: 'update', id: knownId, text: 'y', keywords: [], sourceMessageIds: [] },
      ],
      // 非法 keywords / sources 形状
      [{ op: 'add', text: 'x', keywords: [1] as unknown as string[], sourceMessageIds: [] }],
      [{ op: 'add', text: 'x', keywords: [], sourceMessageIds: ['om_1', null as unknown as string] }],
    ];
    for (const mutations of badBatches) {
      expect(() => store.commitSummaryUpdate({
        topicKey: topic.topicKey,
        expectedRevision: committed.revision,
        mutations,
        generatorKey: 'm/v1',
        now: T2,
        summarizedThroughCursor: 'om_100',
      })).toThrow(TopicMutationValidationError);
    }
    const after = store.getTopic(topic.topicKey)!;
    expect(after.summaries).toHaveLength(1);
    expect(after.summaries[0].text).toBe('已有摘要');
    expect(after.summarizedThroughCursor).toBe('om_1');
    expect(after.revision).toBe(committed.revision);
    store.close();
  });

  it('模型不能指定 add 的 id（服务端分配）', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: 'A', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T1,
    });
    expect(committed.summaries[0].id).toMatch(/^ts_[0-9a-f-]{36}$/);
    store.close();
  });
});

describe('来源时间观察（change.md §3）', () => {
  it('latestMessageAt 只前进；topicCreatedAt 只后退；不动 revision；仅 latest 变化动 updatedAt', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const t1 = '2026-10-01T00:00:00.000Z';
    const t2 = '2026-10-03T00:00:00.000Z';
    const revisionBefore = store.getTopic(topic.topicKey)!.revision;
    const updatedBefore = store.getTopic(topic.topicKey)!.updatedAt;
    store.observeTopicTimes(topic.topicKey, { earliestObservedAt: t1, latestObservedAt: t2 }, '2026-10-29T00:00:00.000Z');
    let stored = store.getTopic(topic.topicKey)!;
    expect(stored.topicCreatedAt).toBe(t1);
    expect(stored.latestMessageAt).toBe(t2);
    expect(stored.revision).toBe(revisionBefore); // 元数据不是知识变更
    expect(stored.updatedAt).toBe('2026-10-29T00:00:00.000Z'); // latest 前进 → updatedAt 动
    // 乱序观察：更晚窗口在前、更早历史在后
    store.observeTopicTimes(topic.topicKey, { earliestObservedAt: '2026-10-02T00:00:00.000Z', latestObservedAt: '2026-10-02T00:00:00.000Z' }, '2026-10-30T00:00:00.000Z');
    stored = store.getTopic(topic.topicKey)!;
    expect(stored.topicCreatedAt).toBe(t1); // 更早的历史才回退创建时间
    expect(stored.latestMessageAt).toBe(t2); // 更旧窗口不动最新消息时间
    expect(stored.updatedAt).toBe('2026-10-29T00:00:00.000Z'); // 无变化不动 updatedAt
    expect(stored.revision).toBe(revisionBefore);
    void updatedBefore;
    store.close();
  });
});

describe('游标与检查状态', () => {
  it('recordHistoryCheck 只推进 lastCheckedAt，不动摘要游标', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: 'A', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T1,
      summarizedThroughCursor: 'om_10',
    });
    store.recordHistoryCheck(topic.topicKey, T2);
    const after = store.getTopic(topic.topicKey)!;
    expect(after.lastCheckedAt).toBe(T2);
    expect(after.summarizedThroughCursor).toBe('om_10'); // 读取成功 ≠ 摘要成功
    expect(after.revision).toBe(committed.revision);
    store.close();
  });
});

describe('向量失效与迟到结果', () => {
  it('摘要正文变化后旧向量立即不可用；迟到向量按 contentHash 丢弃', async () => {
    const store = await openStore();
    const topic = seededTopic(store);
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'add', text: 'v1 正文', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T1,
    });
    const id = committed.summaries[0].id;
    const hashV1 = computeSummaryContentHash('v1 正文');
    expect(store.saveEmbedding({ topicKey: topic.topicKey, summaryId: id, modelKey: 'emb/v1', contentHash: hashV1, vector: [0.1, 0.2], now: T1 }).saved).toBe(true);
    expect(store.getTopic(topic.topicKey)!.summaries[0].embedding?.vector).toEqual([0.1, 0.2]);

    const updated = store.commitSummaryUpdate({
      topicKey: topic.topicKey,
      expectedRevision: committed.revision,
      mutations: [{ op: 'update', id, text: 'v2 正文', keywords: [], sourceMessageIds: [] }],
      generatorKey: 'm/v1',
      now: T2,
    });
    // 旧向量已在同一事务内失效
    expect(store.listEmbeddings(topic.topicKey)).toHaveLength(0);
    expect(store.getTopic(topic.topicKey)!.summaries[0].embedding).toBeUndefined();
    // 用旧 hash 的迟到向量结果被丢弃
    const late = store.saveEmbedding({ topicKey: topic.topicKey, summaryId: id, modelKey: 'emb/v1', contentHash: hashV1, vector: [9, 9], now: T2 });
    expect(late).toEqual({ saved: false, reason: 'content_hash_mismatch' });
    expect(updated.summaries[0].text).toBe('v2 正文');
    // 新 hash 的结果正常落库
    const fresh = store.saveEmbedding({ topicKey: topic.topicKey, summaryId: id, modelKey: 'emb/v1', contentHash: computeSummaryContentHash('v2 正文'), vector: [0.3], now: T2 });
    expect(fresh.saved).toBe(true);
    store.close();
  });

  it('不存在的 summary/topic 拒绝保存向量', async () => {
    const store = await openStore();
    seededTopic(store);
    expect(store.saveEmbedding({ topicKey: 'thread:oc_a:om_root1', summaryId: 'ts_missing', modelKey: 'm', contentHash: 'h', vector: [], now: T1 }).reason).toBe('summary_missing');
    expect(store.saveEmbedding({ topicKey: 'thread:oc_a:om_NONE', summaryId: 'ts_x', modelKey: 'm', contentHash: 'h', vector: [], now: T1 }).reason).toBe('topic_missing');
    store.close();
  });
});

describe('任务队列（幂等键/租约/退避）', () => {
  it('同 jobKey 重复入队是 no-op，保留原状态', async () => {
    const store = await openStore();
    const first = store.enqueueJob({ jobKey: 'summary:t1:om_5', kind: 'summary', topicKey: 'thread:oc_a:om_root1', now: T0 });
    expect(first.enqueued).toBe(true);
    const second = store.enqueueJob({ jobKey: 'summary:t1:om_5', kind: 'summary', topicKey: 'thread:oc_a:om_root1', now: T1 });
    expect(second.enqueued).toBe(false);
    expect(second.job.createdAt).toBe(first.job.createdAt);
    store.close();
  });

  it('认领带租约并计数；未到期（next_attempt_at）不可认领', async () => {
    const store = await openStore();
    store.enqueueJob({ jobKey: 'j1', kind: 'summary', topicKey: 't', now: T0 });
    store.enqueueJob({ jobKey: 'j2', kind: 'embedding', topicKey: 't', now: T0 });
    // 失败一次 → j1 进入退避
    const claimed = store.claimDueJobs({ now: T0, owner: 'w1', leaseTtlMs: 60_000, limit: 10 });
    expect(claimed.map(j => j.jobKey).sort()).toEqual(['j1', 'j2']);
    expect(claimed.every(j => j.state === 'running' && j.attemptCount === 1 && j.leaseOwner === 'w1')).toBe(true);
    store.finishJob('j1', { ok: false, errorCode: 'model_timeout', now: T0 });
    const failed = store.getJob('j1')!;
    expect(failed.state).toBe('failed');
    expect(failed.lastErrorCode).toBe('model_timeout');
    expect(failed.nextAttemptAt).toBe(new Date(Date.parse(T0) + jobRetryDelayMs(1)).toISOString());
    // 退避窗口内不可认领；kinds 过滤生效
    expect(store.claimDueJobs({ now: T0, owner: 'w2', leaseTtlMs: 60_000, limit: 10, kinds: ['summary'] })).toHaveLength(0);
    // 窗口过后可再认领
    const retryAt = failed.nextAttemptAt!;
    expect(store.claimDueJobs({ now: retryAt, owner: 'w2', leaseTtlMs: 60_000, limit: 10, kinds: ['summary'] }).map(j => j.jobKey)).toEqual(['j1']);
    store.close();
  });

  it('失败重试耗尽转 dead，不再认领', async () => {
    const store = await openStore();
    store.enqueueJob({ jobKey: 'j1', kind: 'summary', topicKey: 't', maxAttempts: 2, now: T0 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [job] = store.claimDueJobs({ now: jobNthAttemptNow(attempt), owner: 'w', leaseTtlMs: 60_000, limit: 1 });
      store.finishJob('j1', { ok: false, errorCode: 'provider_error', now: job.updatedAt });
    }
    const dead = store.getJob('j1')!;
    expect(dead.state).toBe('dead');
    expect(dead.lastErrorCode).toBe('provider_error');
    expect(store.claimDueJobs({ now: '2027-01-01T00:00:00.000Z', owner: 'w', leaseTtlMs: 60_000, limit: 10 })).toHaveLength(0);
    store.close();

    function jobNthAttemptNow(attempt: number): string {
      return new Date(Date.parse(T0) + jobRetryDelayMs(attempt - 1) * attempt).toISOString();
    }
  });

  it('脱敏：非白名单错误码归一为 unknown', async () => {
    const store = await openStore();
    store.enqueueJob({ jobKey: 'j1', kind: 'summary', topicKey: 't', now: T0 });
    const [job] = store.claimDueJobs({ now: T0, owner: 'w', leaseTtlMs: 60_000, limit: 1 });
    store.finishJob('j1', { ok: false, errorCode: 'OpenAI API key invalid: sk-xxxx', now: job.updatedAt });
    expect(store.getJob('j1')!.lastErrorCode).toBe('unknown');
    store.close();
  });

  it('崩溃租约过期后回收为可认领（不静默丢失）', async () => {
    const store = await openStore();
    store.enqueueJob({ jobKey: 'j1', kind: 'summary', topicKey: 't', maxAttempts: 3, now: T0 });
    store.claimDueJobs({ now: T0, owner: 'crashed-worker', leaseTtlMs: 1_000, limit: 1 });
    expect(store.getJob('j1')!.state).toBe('running');
    // 租约未过期：expireLeases 不动它
    store.expireLeases(new Date(Date.parse(T0) + 500).toISOString());
    expect(store.getJob('j1')!.state).toBe('running');
    // 过期后回收为 pending，可再次认领且 attemptCount 继续累计
    const afterExpiry = new Date(Date.parse(T0) + 2_000).toISOString();
    expect(store.expireLeases(afterExpiry)).toBe(1);
    const [reclaimed] = store.claimDueJobs({ now: afterExpiry, owner: 'w2', leaseTtlMs: 60_000, limit: 1 });
    expect(reclaimed.jobKey).toBe('j1');
    expect(reclaimed.attemptCount).toBe(2);
    store.close();
  });
});

describe('部署级租约', () => {
  it('同槽位互斥；续约/释放只认 owner', async () => {
    const store = await openStore();
    const slot = { slotKey: 'daily-02:00', now: T0, ttlMs: 60_000 };
    expect(store.tryAcquireDeploymentLease({ ...slot, owner: 'A' }).acquired).toBe(true);
    const stolen = store.tryAcquireDeploymentLease({ ...slot, owner: 'B' });
    expect(stolen.acquired).toBe(false);
    expect(stolen.holder).toBe('A');
    // 同 owner 视为续约，可再次获得
    expect(store.tryAcquireDeploymentLease({ ...slot, owner: 'A' }).acquired).toBe(true);
    // 释放只认 owner
    store.releaseDeploymentLease(slot.slotKey, 'B', T1);
    expect(store.tryAcquireDeploymentLease({ ...slot, owner: 'B' }).acquired).toBe(false);
    store.releaseDeploymentLease(slot.slotKey, 'A', T1);
    expect(store.tryAcquireDeploymentLease({ ...slot, owner: 'B' }).acquired).toBe(true);
    store.close();
  });

  it('租约过期后其他持有者可接管（错过槽位合并为一次增量运行）', async () => {
    const store = await openStore();
    store.tryAcquireDeploymentLease({ slotKey: 's', owner: 'A', now: T0, ttlMs: 1_000 });
    const later = new Date(Date.parse(T0) + 2_000).toISOString();
    expect(store.tryAcquireDeploymentLease({ slotKey: 's', owner: 'B', now: later, ttlMs: 1_000 }).acquired).toBe(true);
    store.close();
  });
});
