import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTopicStore, type TopicStore } from '../src/topic/store.js';
import type { SummaryMutation, TopicEnricher } from '../src/topic/model-client.js';
import type { TopicDirectoryEntry, TopicHistoryReader, TopicSourceMessage } from '../src/topic/source.js';
import { encodeCursor } from '../src/topic/source.js';
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
  const readMessages = vi.fn(async () => queue.shift() ?? { messages: [], truncated: false });
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
    const outcome = await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_5', 5)], truncated: true }]), enricher },
      entry,
      {},
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('source_window_too_narrow');
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(store.getTopic('thread:oc_1:om_1')!.summaries).toHaveLength(1);
  });

  it('CAS 冲突后重读：语义前提已变的 update 被丢弃，add 仍然提交', async () => {
    // 先是已经有一批摘要
    await updateTopicFromSource(
      { store, source: fakeSource([{ messages: [message('om_1', 1)] }]), enricher: fakeEnricher([
        { op: 'add', text: '原始摘要', keywords: [], sourceMessageIds: ['om_1'] },
      ]) },
      entry,
      {},
    );
    const existing = store.getTopic('thread:oc_1:om_1')!.summaries[0];

    // 模型调用期间，另一个进程改了这条摘要并推进了 revision。
    const source = fakeSource([{ messages: [message('om_2', 2)] }]);
    const enricher: TopicEnricher = {
      generatorKey: 'test-model@v1',
      enrich: vi.fn(async () => {
        const topic = store.getTopic('thread:oc_1:om_1')!;
        store.commitSummaryMutation({
          topicKey: 'thread:oc_1:om_1',
          expectedRevision: topic.revision,
          mutations: [
            { op: 'update', id: existing.id, text: '别人改的新正文', keywords: [], sourceMessageIds: ['om_9'] },
          ],
          nextCursor: encodeCursor({ createTime: message('om_9', 9).createTime, messageIds: ['om_9'] }),
          sourceThroughAt: '2026-10-01T00:00:09.000Z',
          generatorKey: 'other-model@v1',
          now: '2026-10-01T00:00:09.000Z',
        });
        return {
          mutations: [
            { op: 'update', id: existing.id, text: '基于旧正文的补充', keywords: [], sourceMessageIds: ['om_2'] },
            { op: 'add', text: '新增事件', keywords: [], sourceMessageIds: ['om_2'] },
          ],
          generatorKey: 'test-model@v1',
        };
      }) as never,
    };
    const outcome = await updateTopicFromSource({ store, source, enricher }, entry, {});
    expect(outcome.status).toBe('committed');
    expect(outcome.added).toBe(1);
    expect(outcome.updated).toBe(0);
    const texts = store.getTopic('thread:oc_1:om_1')!.summaries.map(summary => summary.text).sort();
    expect(texts).toEqual(['别人改的新正文', '新增事件']);
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
