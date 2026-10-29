import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openTopicStore, type TopicStore } from '../src/topic/store.js';
import { createTopicSearchService, TopicSearchError } from '../src/topic/search.js';
import { summaryContentHash } from '../src/topic/vector.js';

let dir: string;
let store: TopicStore;

function addTopic(key: { chatId: string; rootMessageId: string }, title: string, summary: {
  text: string;
  keywords: string[];
  sourceMessageIds?: string[];
}): string {
  const topicKey = `thread:${key.chatId}:${key.rootMessageId}`;
  store.upsertTopicDirectory({
    topicKey,
    chatId: key.chatId,
    rootMessageId: key.rootMessageId,
    title,
    accessPolicyRef: 'deployment:topic-search',
    now: '2026-10-01T00:00:00.000Z',
    coverageStartAt: '2026-10-01T00:00:00.000Z',
  });
  const topic = store.getTopic(topicKey)!;
  const result = store.commitSummaryMutation({
    topicKey,
    expectedRevision: topic.revision,
    mutations: [
      {
        op: 'add',
        text: summary.text,
        keywords: summary.keywords,
        sourceMessageIds: summary.sourceMessageIds ?? ['om_src'],
      },
    ],
    nextCursor: 'cursor',
    sourceThroughAt: '2026-10-01T00:00:00.000Z',
    generatorKey: 'test@v1',
    now: '2026-10-01T00:00:00.000Z',
  });
  if (result.status !== 'committed') throw new Error('commit failed');
  return result.summaries[0].id;
}

function service(options: Parameters<typeof createTopicSearchService>[0] extends infer P ? Partial<P> : never = {}) {
  return createTopicSearchService({ store, ...options } as never);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-search-test-'));
  store = openTopicStore({ path: join(dir, 'topics.sqlite') });
  addTopic(
    { chatId: 'oc_1', rootMessageId: 'om_1' },
    '跨 bot owner 校验',
    { text: '决定把跨 bot owner 校验放到 setup 层，跨应用 open_id 不可比较', keywords: ['owner', 'setup'] },
  );
  addTopic(
    { chatId: 'oc_1', rootMessageId: 'om_2' },
    '支付超时排障',
    { text: '支付链路超时定位到网关限流', keywords: ['支付', '超时'] },
  );
  addTopic(
    { chatId: 'oc_2', rootMessageId: 'om_3' },
    '沙箱文件策略',
    { text: 'bwrap 沙箱白名单与只读挂载', keywords: ['沙箱', 'bwrap'] },
  );
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const allChats = { visibleChatIds: ['oc_1', 'oc_2'] };

describe('关键词检索', () => {
  it('按话题去重返回，并带命中摘要与来源消息', async () => {
    const result = await service().search({ query: 'owner' }, allChats);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].topicKey).toBe('thread:oc_1:om_1');
    expect(result.items[0].matches[0]).toMatchObject({
      text: expect.stringContaining('owner'),
      sourceMessageIds: ['om_src'],
    });
  });

  it('多词查询是 AND：缺任一 token 不算命中', async () => {
    const both = await service().search({ query: '支付 网关' }, allChats);
    expect(both.items.map(item => item.title)).toEqual(['支付超时排障']);
    const impossible = await service().search({ query: '支付 沙箱' }, allChats);
    expect(impossible.items).toEqual([]);
  });

  it('中文按二元组分词，能命中连续片段', async () => {
    const result = await service().search({ query: '网关限流' }, allChats);
    expect(result.items.map(item => item.title)).toEqual(['支付超时排障']);
  });

  it('显式可见范围仍然先收窄：范围外的群即使命中也不返回', async () => {
    const scoped = await service().search({ query: '沙箱' }, { visibleChatIds: ['oc_1'] });
    expect(scoped.items).toEqual([]);
    const full = await service().search({ query: '沙箱' }, allChats);
    expect(full.items.map(item => item.title)).toEqual(['沙箱文件策略']);
  });

  it('省略可见范围 = Dashboard 已认证可读全部历史（更新范围不参与检索准入）', async () => {
    const result = await service().search({ query: '沙箱' }, {});
    expect(result.items.map(item => item.title)).toEqual(['沙箱文件策略']);
  });

  it('无可见范围返回空结果而不是全库', async () => {
    const result = await service().search({ query: 'owner' }, { visibleChatIds: [] });
    expect(result.items).toEqual([]);
    expect(result.degradedReasons).toContain('no_authorized_scope');
  });

  it('请求可见范围外的 chat 过滤直接 403（不能借过滤提权）', async () => {
    await expect(
      service().search({ query: 'owner', filters: { chatIds: ['oc_9'] } }, allChats),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('候选预算在过滤之后才计数：范围外话题不能挤掉授权内的命中', async () => {
    // topic_key 排序下 oc_0 会排在 oc_1 前面；预算 1 时旧实现会先截到 oc_0。
    addTopic(
      { chatId: 'oc_0', rootMessageId: 'om_0' },
      '范围外旧话题',
      { text: 'owner 相关但不可见的历史讨论', keywords: ['owner'] },
    );
    const result = await service({ maxCandidateTopics: 1 })
      .search({ query: 'owner' }, { visibleChatIds: ['oc_1'] });
    expect(result.items.map(item => item.title)).toEqual(['跨 bot owner 校验']);
    // 预算按可见候选计（oc_1 有 2 个话题），所以仍会标 partial；关键是范围外的 oc_0
    // 没有把唯一预算名额占掉。
    expect(result.coverage.state).toBe('partial');
  });

  it('有效候选超出预算时明确 partial，而不是静默截断', async () => {
    const result = await service({ maxCandidateTopics: 1 })
      .search({ query: 'owner' }, { visibleChatIds: ['oc_1'] });
    expect(result.degradedReasons).toContain('candidate_budget_truncated');
  });

  it('mode=keyword 时不请求向量', async () => {
    const embedQuery = vi.fn(async () => ({ vector: [1, 0], modelKey: 'host/m/2' }));
    const result = await service({ embedQuery }).search({ query: 'owner', mode: 'keyword' }, allChats);
    expect(result.effectiveMode).toBe('keyword');
    expect(embedQuery).not.toHaveBeenCalled();
  });
});

describe('混合召回与降级', () => {
  it('auto + 有向量时用 hybrid；查询向量不可用则降级为关键词并说明原因', async () => {
    const summaryId = store.getTopic('thread:oc_1:om_1')!.summaries[0].id;
    store.markSummaryEmbedding({
      topicKey: 'thread:oc_1:om_1',
      summaryId,
      modelKey: 'host/m/2',
      contentHash: summaryContentHash(store.getTopic('thread:oc_1:om_1')!.summaries[0].text),
      vector: [1, 0],
      now: '2026-10-01T00:00:00.000Z',
    });
    const hybrid = await service({
      embedQuery: async () => ({ vector: [1, 0], modelKey: 'host/m/2' }),
    }).search({ query: 'owner', mode: 'auto' }, allChats);
    expect(hybrid.effectiveMode).toBe('hybrid');

    const degraded = await service({ embedQuery: async () => null }).search({ query: 'owner', mode: 'auto' }, allChats);
    expect(degraded.effectiveMode).toBe('keyword');
    expect(degraded.degradedReasons).toContain('embedding_unavailable');
    expect(degraded.items).toHaveLength(1);
  });

  it('向量空间不匹配时不参与打分（不混用不同 modelKey）', async () => {
    const summaryId = store.getTopic('thread:oc_1:om_1')!.summaries[0].id;
    store.markSummaryEmbedding({
      topicKey: 'thread:oc_1:om_1',
      summaryId,
      modelKey: 'other/model/2',
      contentHash: summaryContentHash(store.getTopic('thread:oc_1:om_1')!.summaries[0].text),
      vector: [1, 0],
      now: '2026-10-01T00:00:00.000Z',
    });
    const result = await service({
      embedQuery: async () => ({ vector: [1, 0], modelKey: 'host/m/2' }),
    }).search({ query: 'owner', mode: 'hybrid' }, allChats);
    expect(result.effectiveMode).toBe('keyword');
    expect(result.degradedReasons).toContain('embedding_not_backfilled');
  });
});

describe('分页、预算与错误码', () => {
  it('结果多于 limit 时给出 nextCursor，翻页拿到剩下的', async () => {
    const first = await service().search({ query: 'owner OR 支付 OR 沙箱', limit: 1 }, allChats);
    // 该查询是 AND 语义，不会命中任何话题；换一个三话题都能命中的查询：
    expect(first.items).toEqual([]);

    const page1 = await service().search({ query: '沙箱', limit: 1 }, allChats);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeNull();
  });

  it('游标绑定查询：换了查询串的游标被判无效', async () => {
    const svc = service();
    // 先构造一个有多页的场景：同一 token 命中两个话题。
    addTopic({ chatId: 'oc_1', rootMessageId: 'om_4' }, '另一个 owner 话题', {
      text: 'owner 相关的第二次讨论',
      keywords: ['owner'],
    });
    const page1 = await svc.search({ query: 'owner', limit: 1 }, allChats);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await svc.search({ query: 'owner', limit: 1, cursor: page1.nextCursor }, allChats);
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].topicKey).not.toBe(page1.items[0].topicKey);
    await expect(svc.search({ query: '支付', limit: 1, cursor: page1.nextCursor }, allChats)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });

  it('覆盖不完整时明确 partial，而不是伪装成全量', async () => {
    const result = await service({ knownTopicCount: () => 10 }).search({ query: 'owner' }, allChats);
    expect(result.coverage.state).toBe('partial');
    expect(result.coverage.unindexedKnownTopics).toBeGreaterThan(0);

    const complete = await service({ knownTopicCount: () => 3 }).search({ query: 'owner' }, allChats);
    expect(complete.coverage.state).toBe('complete');
  });

  it('非法输入有明确错误码', async () => {
    const svc = service();
    await expect(svc.search({ query: '   ' }, allChats)).rejects.toBeInstanceOf(TopicSearchError);
    await expect(svc.search({ query: 'owner', limit: 0 }, allChats)).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(svc.search({ query: 'owner', limit: 999 }, allChats)).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(
      svc.search({ query: 'owner', filters: { sourceFrom: 'not-a-date' } }, allChats),
    ).rejects.toMatchObject({ code: 'invalid_filter' });
  });
});
