import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTopicStore, type TopicStore } from '../src/topic/store.js';
import type { SummaryMutation, TopicEnricher } from '../src/topic/model-client.js';
import type { TopicDirectoryEntry, TopicHistoryReader, TopicSourceMessage } from '../src/topic/source.js';
import { encodeCursor } from '../src/topic/source.js';
import { createTopicSearchService } from '../src/topic/search.js';
import {
  computeRetryAtIso,
  runEmbeddingBackfill,
  updateTopicFromSource,
} from '../src/topic/summary-updater.js';
import { summaryContentHash } from '../src/topic/vector.js';

const entry: TopicDirectoryEntry = {
  chatId: 'oc_1',
  rootMessageId: 'om_1',
  title: '跨 bot owner 校验',
  accessPolicyRef: 'deployment:topic-search',
};

let dir: string;
let store: TopicStore;

function message(messageId: string, second: number, text = '讨论内容'): TopicSourceMessage {
  return {
    messageId,
    createTime: new Date(Date.parse('2026-10-01T00:00:00.000Z') + second * 1000).toISOString(),
    text,
  };
}

function fakeSource(pages: Array<{ messages: TopicSourceMessage[]; truncated?: boolean }>): TopicHistoryReader & {
  readMessages: ReturnType<typeof vi.fn>;
} {
  const queue = [...pages];
  const readMessages = vi.fn(async () => ({
    verifiedThread: true,
    ...(queue.shift() ?? { messages: [], truncated: false }),
  }));
  return { discoverTopics: async () => [entry], readMessages } as never;
}

function fakeEnricher(mutations: SummaryMutation[] | (() => Promise<never>)): TopicEnricher {
  return {
    generatorKey: 'test-model@v1',
    enrich: vi.fn(async () => {
      if (typeof mutations === 'function') return mutations();
      return { mutations, generatorKey: 'test-model@v1' };
    }) as never,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-updater-test-'));
  store = openTopicStore({ path: join(dir, 'topics.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('增量摘要更新', () => {
  it('没有增量时零模型调用，只记检查时间', async () => {
    const source = fakeSource([{ messages: [] }]);
    const enricher = fakeEnricher([]);
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});
    expect(outcome.status).toBe('no_increment');
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(store.getTopic('thread:oc_1:om_1')!.lastCheckedAt).toBeTruthy();
    expect(store.getTopic('thread:oc_1:om_1')!.summarizedThroughCursor).toBeUndefined();
  });

  it('有增量时提交摘要并推进游标', async () => {
    const source = fakeSource([{ messages: [message('om_1', 1), message('om_2', 2)] }]);
    const enricher = fakeEnricher([
      { op: 'add', text: '决定把 owner 校验放到 setup 层', keywords: ['owner'], sourceMessageIds: ['om_1', 'om_2'] },
    ]);
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});
    expect(outcome.status).toBe('committed');
    expect(outcome.added).toBe(1);
    expect(outcome.cursorAdvanced).toBe(true);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toHaveLength(1);
    expect(topic.summaries[0].generatorKey).toBe('test-model@v1');
    expect(topic.summarizedThroughCursor).toBeTruthy();
    expect(topic.sourceThroughAt).toBeTruthy();
  });

  it('模型失败时不推进游标，并记录可重试的退避', async () => {
    const source = fakeSource([{ messages: [message('om_1', 1)] }]);
    const enricher = fakeEnricher(async () => {
      throw Object.assign(new Error('boom'), { code: 'timeout' });
    });
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('timeout');
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summarizedThroughCursor).toBeUndefined();
    expect(topic.summaries).toHaveLength(0);
    const job = store.jobState('thread:oc_1:om_1')!;
    expect(job.attempts).toBe(1);
    expect(job.errorCode).toBe('timeout');
    expect(job.nextAttemptAt).toBeTruthy();
  });

  it('源窗口没覆盖到游标时整轮放弃（不提交、不调模型），不让游标跨过读不到的中间段', async () => {
    const first = await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1)] }]), enricher: fakeEnricher([
        { op: 'add', text: '第一批', keywords: [], sourceMessageIds: ['om_1'] },
      ]) },
      entry,
      {},
    );
    expect(first.status).toBe('committed');

    const enricher = fakeEnricher([]);
    const alwaysTruncated = {
      discoverTopics: async () => [entry],
      readMessages: vi.fn(async () => ({ messages: [message('om_5', 5)], truncated: true })),
    } as never;
    const outcome = await updateTopicFromSource(
      { store, source: alwaysTruncated, enricher },
      entry,
      {},
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('source_window_too_narrow');
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);
  });

  it('CAS 冲突时若另一写者已处理同批，不重放旧 add（不产生重复摘要）', async () => {
    // 先是已经有一批摘要
    await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1)] }]), enricher: fakeEnricher([
        { op: 'add', text: '原始摘要', keywords: [], sourceMessageIds: ['om_1'] },
      ]) },
      entry,
      {},
    );

    // 模型调用期间，另一个实例处理了同一批（om_2）并推进了游标与 revision。
    const source = fakeSource([{ messages: [message('om_1', 1), message('om_2', 2)] }]);
    const enricher: TopicEnricher = {
      generatorKey: 'test-model@v1',
      enrich: vi.fn(async () => {
        const topic = store.getTopic('thread:oc_1:om_1')!;
        const concurrent = store.commitSummaryMutation({
          topicKey: 'thread:oc_1:om_1',
          expectedRevision: topic.revision,
          mutations: [
            { op: 'add', text: '并发写入的摘要', keywords: [], sourceMessageIds: ['om_2'] },
          ],
          nextCursor: encodeCursor({ createTime: message('om_2', 2).createTime, messageIds: ['om_2'] }),
          sourceThroughAt: '2026-10-01T00:00:02.000Z',
          generatorKey: 'other-model@v1',
          now: '2026-10-01T00:00:09.000Z',
        });
        expect(concurrent.status).toBe('committed');
        return {
          mutations: [
            { op: 'add', text: '本实例的重复摘要', keywords: [], sourceMessageIds: ['om_2'] },
          ],
          generatorKey: 'test-model@v1',
        };
      }) as never,
    };
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});

    // 对方已覆盖本批边界：按已处理收尾，绝不重放本实例的 add。
    expect(outcome.status).toBe('committed');
    expect(outcome.added).toBe(0);
    expect(outcome.updated).toBe(0);
    const texts = store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text).sort();
    expect(texts).toEqual(['原始摘要', '并发写入的摘要']);

    // 下一轮不会再补一条重复摘要。
    const next = await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1), message('om_2', 2)] }]), enricher: fakeEnricher([]) },
      entry,
      {},
    );
    expect(next.status).toBe('no_increment');
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(2);
  });

  it('整批都是已删除消息时用 noop 推进游标（否则会被永久重读）', async () => {
    const deleted: TopicSourceMessage = { ...message('om_1', 1), deleted: true };
    const enricher = fakeEnricher([]);
    const outcome = await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [deleted] }]), enricher },
      entry,
      {},
    );
    expect(outcome.status).toBe('committed');
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(store.getTopic('thread:oc_1:om_1')!.summarizedThroughCursor).toBeTruthy();
  });

  it('失败退避未到点时跳过该话题（不读源、不烧模型）', async () => {
    const source = fakeSource([{ messages: [message('om_1', 1)] }]);
    const enricher = fakeEnricher([]);
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {
      skipUntil: () => true,
    });
    expect(outcome.status).toBe('skipped');
    expect(source.readMessages).not.toHaveBeenCalled();
    expect(enricher.enrich).not.toHaveBeenCalled();
  });

  it('源侧确认删除：先失效引用摘要再提交，且整批都是删除时仍推进游标', async () => {
    // 预置：摘要引用了 om_100，游标停在更早的 om_0。
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    const seeded = store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '含 om_100 的旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });
    expect(seeded.status).toBe('committed');

    const source = fakeSource([{
      messages: [{ ...message('om_100', 2), deleted: true }],
    }]);
    const enricher = fakeEnricher([]);
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});

    expect(outcome.status).toBe('committed');
    expect(outcome.cursorAdvanced).toBe(true);
    expect(outcome.invalidated).toBe(1);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toEqual([]);
    // 删除批也必须推进游标，否则会被永久重读。
    expect(topic.summarizedThroughCursor).toBeTruthy();
  });

  it('模型失败不推进游标，但已确认删除的摘要仍然失效（不继续泄露）', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '含 om_100 的旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });

    const source = fakeSource([{
      messages: [{ ...message('om_100', 2), deleted: true }, message('om_101', 3)],
    }]);
    const enricher = fakeEnricher(async () => {
      throw Object.assign(new Error('boom'), { code: 'timeout' });
    });
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});

    expect(outcome.status).toBe('failed');
    expect(outcome.cursorAdvanced).toBe(false);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toEqual([]);
    expect(topic.summarizedThroughCursor).toBe(
      encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
    );
  });
  it('模型失败仍记录已观察到的最新消息时间，成功摘要游标保持不变', async () => {
    const day1 = { messageId: 'om_day1', createTime: '2026-10-01T08:00:00.000Z', text: '话题创建' };
    const first = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [day1], topicCreatedAt: day1.createTime }]),
        enricher: fakeEnricher([
          { op: 'add', text: '话题创建', keywords: ['创建'], sourceMessageIds: ['om_day1'] },
        ]),
        now: () => '2026-10-01T09:00:00.000Z',
      },
      entry,
      {},
    );
    expect(first.status).toBe('committed');
    const afterFirst = store.getTopic('thread:oc_1:om_1')!;
    expect(afterFirst.topicCreatedAt).toBe(day1.createTime);
    expect(afterFirst.latestMessageAt).toBe(day1.createTime);
    const successCursor = afterFirst.summarizedThroughCursor;

    // 10 月 3 日读到新消息，但模型失败：最新消息时间要更新，成功游标不动。
    const day3 = { messageId: 'om_day3', createTime: '2026-10-03T08:00:00.000Z', text: '新消息' };
    const second = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [day1, day3] }]),
        enricher: fakeEnricher(async () => {
          throw Object.assign(new Error('model down'), { code: 'timeout' });
        }),
        now: () => '2026-10-03T09:00:00.000Z',
      },
      entry,
      {},
    );
    expect(second.status).toBe('failed');
    expect(second.cursorAdvanced).toBe(false);
    const afterSecond = store.getTopic('thread:oc_1:om_1')!;
    expect(afterSecond.latestMessageAt).toBe(day3.createTime);
    expect(afterSecond.summarizedThroughCursor).toBe(successCursor);
    expect(afterSecond.sourceThroughAt).toBe(day1.createTime);

    const search = createTopicSearchService({ store });
    const byCreated = await search.search({
      query: '',
      timeFilter: { field: 'created', from: '2026-10-01T00:00:00Z', to: '2026-10-02T23:59:59Z' },
    }, {});
    expect(byCreated.items).toHaveLength(1);
    const latestNotInOldRange = await search.search({
      query: '',
      timeFilter: { field: 'latestMessage', from: '2026-10-01T00:00:00Z', to: '2026-10-02T23:59:59Z' },
    }, {});
    expect(latestNotInOldRange.items).toEqual([]);
    const latestOnDay3 = await search.search({
      query: '',
      timeFilter: { field: 'latestMessage', from: '2026-10-03T00:00:00Z', to: '2026-10-03T23:59:59Z' },
    }, {});
    expect(latestOnDay3.items).toHaveLength(1);
  });

  it('sourceThroughAt / coverageStartAt 取消息时间，而不是处理时刻', async () => {
    const older = { messageId: 'om_old', createTime: '2026-09-20T08:00:00.000Z', text: '九月决定' };
    const newer = { messageId: 'om_new', createTime: '2026-09-21T08:00:00.000Z', text: '九月补充' };
    const outcome = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [older, newer] }]),
        enricher: fakeEnricher([
          { op: 'add', text: '九月决定', keywords: ['九月'], sourceMessageIds: ['om_old', 'om_new'] },
        ]),
        now: () => '2026-10-29T00:00:00.000Z',
      },
      entry,
      {},
    );
    expect(outcome.status).toBe('committed');
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.coverageStartAt).toBe('2026-09-20T08:00:00.000Z');
    expect(topic.sourceThroughAt).toBe('2026-09-21T08:00:00.000Z');

    const search = createTopicSearchService({ store });
    const inRange = await search.search(
      { query: '九月', filters: { sourceFrom: '2026-09-20T00:00:00Z', sourceTo: '2026-09-21T23:59:59Z' } },
      {},
    );
    expect(inRange.items).toHaveLength(1);
    // 处理时刻是 10 月 29 日，但消息不在 10 月，日期筛选必须按消息时间判。
    const outOfRange = await search.search(
      { query: '九月', filters: { sourceFrom: '2026-10-01T00:00:00Z' } },
      {},
    );
    expect(outOfRange.items).toEqual([]);
  });

  it('已摘要消息被撤回后，下一轮删除旧摘要并正常摘要剩余消息', async () => {
    // 第 1 轮：om_100 被摘要，游标推进到它。
    await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [message('om_100', 2, '预算机密：Q4 总预算 300 万')] }]),
        enricher: fakeEnricher([
          { op: 'add', text: '预算机密：Q4 总预算 300 万', keywords: ['预算'], sourceMessageIds: ['om_100'] },
        ]),
      },
      entry,
      {},
    );
    const search = createTopicSearchService({ store });
    expect((await search.search({ query: '预算' }, { allowedChatIds: ['oc_1'] })).items).toHaveLength(1);

    // 第 2 轮：om_100 被撤回；重叠窗口里只剩 om_101。
    const enricher = fakeEnricher([
      { op: 'add', text: '上线日期 11/15', keywords: ['上线'], sourceMessageIds: ['om_101'] },
    ]);
    const outcome = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [message('om_101', 3, '上线日期 11/15')] }]),
        enricher,
      },
      entry,
      {},
    );

    expect(outcome.invalidated).toBe(1);
    expect(outcome.added).toBe(1);
    expect(store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text))
      .toEqual(['上线日期 11/15']);
    // 旧内容必须从检索里消失，新内容正常命中。
    expect((await search.search({ query: '预算' }, { allowedChatIds: ['oc_1'] })).items).toEqual([]);
    expect((await search.search({ query: '上线' }, { allowedChatIds: ['oc_1'] })).items).toHaveLength(1);
  });

  it('游标提交抛错时落 job 退避，避免每个 tick 重跑完整模型调用', async () => {
    const spy = vi.spyOn(store, 'commitSummaryMutation').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    const outcome = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [message('om_1', 1)] }]),
        enricher: fakeEnricher([
          { op: 'add', text: '摘要', keywords: [], sourceMessageIds: ['om_1'] },
        ]),
      },
      entry,
      {},
    );
    spy.mockRestore();

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('commit_failed');
    expect(store.jobState('thread:oc_1:om_1')?.nextAttemptAt).toBeTruthy();
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toEqual([]);
  });

  it('失效与 revision 冲突同时发生时，重试仍沿用 enrich 前的 epoch（不得绕过）', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '含 om_100 的旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });

    const enricher: TopicEnricher = {
      generatorKey: 'test-model@v1',
      enrich: vi.fn(async () => {
        // 模型拿着删除前快照；期间另一个进程确认撤回并删掉了引用它的摘要，
        // 这会让 revision 与 epoch 同时变化。
        store.invalidateSummariesForMessages({
          topicKey: 'thread:oc_1:om_1',
          messageIds: ['om_100'],
          now: '2026-10-01T00:00:05.000Z',
        });
        return {
          mutations: [
            { op: 'add', text: '基于旧快照的摘要', keywords: [], sourceMessageIds: ['om_101'] },
          ],
          generatorKey: 'test-model@v1',
        };
      }) as never,
    };
    const outcome = await updateTopicFromSource(
      {
        store,
        // 页面里 om_100 仍存在：本轮开始时的缺席判定不会触发，撤销只发生在 enrich 期间。
        source: fakeSource([{ messages: [message('om_100', 2), message('om_101', 3, '新消息')] }]),
        enricher,
      },
      entry,
      {},
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('stale_epoch');
    expect(outcome.cursorAdvanced).toBe(false);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toEqual([]);
    expect(topic.summarizedThroughCursor).toBe(
      encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
    );
  });

  it('退化读取（verifiedThread=false）不做「缺席即删除」，不误删存活摘要', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '引用回复的摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });

    const outcome = await updateTopicFromSource(
      {
        store,
        source: {
          discoverTopics: async () => [entry],
          // 退化扫描看不到回复消息 om_100；它仍然活着，不能判成删除。
          readMessages: async () => ({
            messages: [message('om_101', 3, '新消息')],
            truncated: false,
            verifiedThread: false,
          }),
        } as never,
        enricher: fakeEnricher([
          { op: 'add', text: '新消息摘要', keywords: [], sourceMessageIds: ['om_101'] },
        ]),
      },
      entry,
      {},
    );

    expect(outcome.status).toBe('committed');
    expect(outcome.invalidated).toBeUndefined();
    expect(store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text))
      .toEqual(['引用回复的摘要', '新消息摘要']);
  });

  it('重叠窗口截断时，截断页里显式 deleted 的消息仍然失效', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    const cursorTime = '2026-10-01T00:00:01.000Z';
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: cursorTime, messageIds: ['om_100'] }),
      sourceThroughAt: cursorTime,
      generatorKey: 'test-model@v1',
      now: cursorTime,
    });

    const readMessages = vi.fn(async (
      _entry: TopicDirectoryEntry,
      options: { after?: { createTime: string; messageIds: string[] }; limit: number },
    ) => {
      const afterMs = options.after ? Date.parse(options.after.createTime) : NaN;
      if (Number.isFinite(afterMs) && afterMs < Date.parse(cursorTime)) {
        return {
          messages: [{ ...message('om_100', -1, '已撤回内容'), deleted: true }],
          truncated: true,
        };
      }
      return { messages: [message('om_2', 3, '新消息')], truncated: false };
    });
    const outcome = await updateTopicFromSource(
      {
        store,
        source: { discoverTopics: async () => [entry], readMessages } as never,
        enricher: fakeEnricher([
          { op: 'add', text: '新消息摘要', keywords: [], sourceMessageIds: ['om_2'] },
        ]),
      },
      entry,
      {},
    );

    expect(readMessages).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe('committed');
    expect(outcome.invalidated).toBe(1);
    expect(store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text))
      .toEqual(['新消息摘要']);
  });

  it('重叠窗口被预算截断时退回正常增量，不把话题判成窗口不足', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    const cursorTime = '2026-10-01T00:00:01.000Z';
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: cursorTime, messageIds: ['om_100'] }),
      sourceThroughAt: cursorTime,
      generatorKey: 'test-model@v1',
      now: cursorTime,
    });

    const readMessages = vi.fn(async (
      _entry: TopicDirectoryEntry,
      options: { after?: { createTime: string; messageIds: string[] }; limit: number },
    ) => {
      const afterMs = options.after ? Date.parse(options.after.createTime) : NaN;
      // 重叠窗口读不完（真实源会报 complete=false）；正常游标读得到新消息。
      if (Number.isFinite(afterMs) && afterMs < Date.parse(cursorTime)) {
        return { messages: [], truncated: true };
      }
      return { messages: [message('om_2', 2, '新消息')], truncated: false };
    });
    const enricher = fakeEnricher([
      { op: 'add', text: '新消息摘要', keywords: [], sourceMessageIds: ['om_2'] },
    ]);
    const outcome = await updateTopicFromSource(
      {
        store,
        source: { discoverTopics: async () => [entry], readMessages } as never,
        enricher,
      },
      entry,
      {},
    );

    expect(readMessages).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe('committed');
    expect(outcome.invalidated).toBeUndefined();
    // 旧摘要没有被误删（本轮没做缺席判定），新摘要正常提交。
    expect(store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text))
      .toEqual(['旧摘要', '新消息摘要']);
  });

  it('模型调用期间发生撤回：epoch 变化使整批作废，游标不动', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '含 om_100 的旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });

    const enricher: TopicEnricher = {
      generatorKey: 'test-model@v1',
      enrich: vi.fn(async () => {
        // 模型已经拿着删除前快照，调用期间另一个进程确认了撤回。
        store.invalidateSummariesForMessages({
          topicKey: 'thread:oc_1:om_1',
          messageIds: ['om_100'],
          now: '2026-10-01T00:00:05.000Z',
        });
        return {
          mutations: [
            { op: 'add', text: '基于旧快照的摘要', keywords: [], sourceMessageIds: ['om_101'] },
          ],
          generatorKey: 'test-model@v1',
        };
      }) as never,
    };
    const outcome = await updateTopicFromSource(
      {
        store,
        source: fakeSource([{ messages: [message('om_101', 3, '新消息')] }]),
        enricher,
      },
      entry,
      {},
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('stale_epoch');
    expect(outcome.cursorAdvanced).toBe(false);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toEqual([]);
    expect(topic.summarizedThroughCursor).toBe(
      encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
    );
  });

  it('删除后的晚到模型结果不能把已删内容写回摘要', async () => {
    store.upsertTopicDirectory({
      topicKey: 'thread:oc_1:om_1',
      chatId: 'oc_1',
      rootMessageId: 'om_1',
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: '2026-10-01T00:00:00.000Z',
      coverageStartAt: '2026-10-01T00:00:00.000Z',
    });
    store.commitSummaryMutation({
      topicKey: 'thread:oc_1:om_1',
      expectedRevision: 0,
      mutations: [{ op: 'add', text: '含 om_100 的旧摘要', keywords: [], sourceMessageIds: ['om_100'] }],
      nextCursor: encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
      sourceThroughAt: '2026-10-01T00:00:01.000Z',
      generatorKey: 'test-model@v1',
      now: '2026-10-01T00:00:01.000Z',
    });

    const source = fakeSource([{
      messages: [{ ...message('om_100', 2), deleted: true }, message('om_101', 3)],
    }]);
    // 模型（模拟删除前读到的快照）仍然把 om_100 当作来源。
    const enricher = fakeEnricher([
      { op: 'add', text: '来自已删消息的摘要', keywords: [], sourceMessageIds: ['om_100', 'om_101'] },
      { op: 'add', text: '只基于存活消息的摘要', keywords: [], sourceMessageIds: ['om_101'] },
    ]);
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});

    // 整批作废：不能只丢掉引用墓碑的那条、把同批存活消息连同游标一起吞掉。
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('tombstoned');
    expect(outcome.cursorAdvanced).toBe(false);
    const topic = store.getTopic('thread:oc_1:om_1')!;
    expect(topic.summaries).toEqual([]);
    expect(topic.summarizedThroughCursor).toBe(
      encodeCursor({ createTime: '2026-10-01T00:00:01.000Z', messageIds: ['om_0'] }),
    );
  });
});

describe('失败退避与向量回填', () => {
  it('退避按尝试次数增长且有上限', () => {
    const now = '2026-10-01T00:00:00.000Z';
    const first = Date.parse(computeRetryAtIso(1, now)) - Date.parse(now);
    const third = Date.parse(computeRetryAtIso(3, now)) - Date.parse(now);
    const huge = Date.parse(computeRetryAtIso(30, now)) - Date.parse(now);
    expect(first).toBeGreaterThan(0);
    expect(third).toBeGreaterThan(first);
    expect(huge).toBe(6 * 60 * 60_000);
  });

  it('向量回填只处理缺向量的摘要，成功后任务消失', async () => {
    await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1)] }]), enricher: fakeEnricher([
        { op: 'add', text: '待向量摘要', keywords: [], sourceMessageIds: ['om_1'] },
      ]) },
      entry,
      {},
    );
    expect(store.pendingEmbeddingTasks(10)).toHaveLength(1);
    const embed = vi.fn(async () => [1, 0, 0]);
    const result = await runEmbeddingBackfill({
      store,
      embedder: { modelKey: 'host/model/3', embed },
    });
    expect(result).toMatchObject({ attempted: 1, stored: 1, failed: 0 });
    expect(store.pendingEmbeddingTasks(10)).toHaveLength(0);
    const summary = store.getTopic('thread:oc_1:om_1')!.summaries[0];
    expect(summary.embedding).toMatchObject({
      modelKey: 'host/model/3',
      contentHash: summaryContentHash('待向量摘要'),
    });
  });

  it('向量失败不回滚已提交的摘要（下轮只重试向量）', async () => {
    await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1)] }]), enricher: fakeEnricher([
        { op: 'add', text: '摘要', keywords: [], sourceMessageIds: ['om_1'] },
      ]) },
      entry,
      {},
    );
    const result = await runEmbeddingBackfill({
      store,
      embedder: {
        modelKey: 'host/model/3',
        embed: async () => {
          throw Object.assign(new Error('nope'), { code: 'embedding_failed' });
        },
      },
    });
    expect(result).toMatchObject({ attempted: 1, stored: 0, failed: 1, errorCode: 'embedding_failed' });
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);
    expect(store.pendingEmbeddingTasks(10)).toHaveLength(1);
  });
});
