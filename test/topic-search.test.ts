/** 检索服务行为回归（spec §6，A-05/A-07）：
 *  - 关键词：中文 bigram 召回（语序变体）、多词 AND、精确关键词/错误码高权重、标题命中
 *  - 每话题一条 + 命中摘要片段；filters 只收窄（chatIds/来源时间窗）
 *  - keyword 模式不请求向量；向量失败降级关键词并标注；模型空间不一致不混用
 *  - RRF 融合去重；分页游标绑定查询签名（改条件要求重查）
 *  - 预算：候选超限返回 partial 而非静默宣称完整
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { TopicStore } from '../src/topic/store.js';
import { TopicSearchService, TopicSearchValidationError, MAX_CANDIDATES } from '../src/topic/search.js';
import { tokenizeQuery } from '../src/topic/keyword.js';
import { cosineSimilarity, fuseRankings, vectorRecall } from '../src/topic/vector.js';
import type { Topic } from '../src/types.js';
import type { TopicEmbeddingResult } from '../src/topic/embedding-client.js';

let tempDir: string;
let store: TopicStore;
const T0 = '2026-10-29T00:00:00.000Z';

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-search-test-'));
  store = await TopicStore.open(tempDir);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTopic(index: number, overrides: {
  chatId?: string;
  title?: string;
  summaries?: Array<{ text: string; keywords?: string[]; sourceMessageIds?: string[]; embedding?: [number, number, number, number] }>;
  coverageStartAt?: string;
  sourceThroughAt?: string;
}): Topic {
  const chatId = overrides.chatId ?? 'oc_a';
  const rootId = `om_root${index}`;
  const topicKey = `thread:${chatId}:${rootId}`;
  const ensured = store.ensureTopic({ topicKey, chatId, rootMessageId: rootId, title: overrides.title ?? `话题${index}`, accessPolicyRef: `chat:${chatId}` }, T0).topic;
  let revision = ensured.revision;
  for (const summary of overrides.summaries ?? []) {
    const committed = store.commitSummaryUpdate({
      topicKey, expectedRevision: revision,
      mutations: [{ op: 'add', text: summary.text, keywords: summary.keywords ?? [], sourceMessageIds: summary.sourceMessageIds ?? ['om_x'] }],
      generatorKey: 'g/v1', now: T0,
      ...(overrides.coverageStartAt ? { coverageStartAt: overrides.coverageStartAt } : {}),
      ...(overrides.sourceThroughAt ? { sourceThroughAt: overrides.sourceThroughAt } : {}),
    });
    revision = committed.revision;
    if (summary.embedding) {
      const stored = store.getTopic(topicKey)!;
      const id = stored.summaries[stored.summaries.length - 1].id;
      const hash = createHash('sha256').update(summary.text, 'utf8').digest('hex');
      store.saveEmbedding({ topicKey, summaryId: id, modelKey: 'openai-compatible/emb-1:4', contentHash: hash, vector: [...summary.embedding], now: T0 });
    }
  }
  return store.getTopic(topicKey)!;
}

function embedderOk(vector: number[], modelKey = 'openai-compatible/emb-1:4'): () => Promise<TopicEmbeddingResult> {
  return async () => ({ ok: true, vector, modelKey });
}

async function embedderFail(): Promise<TopicEmbeddingResult> {
  return { ok: false, code: 'http_error' };
}

describe('分词', () => {
  it('拉丁词整词、CJK 转 bigram、单字直通、空白分段', () => {
    const tokens = tokenizeQuery('跨bot owner 权限撤销');
    expect(tokens.words).toEqual(['bot', 'owner']);
    expect(tokens.bigrams).toEqual(['跨', '权限', '限撤', '撤销']);
    expect(tokens.segments).toHaveLength(3); // 「跨bot」「owner」「权限撤销」
  });
});

describe('关键词召回', () => {
  it('中文语序变体召回：查询「权限撤销」命中「撤销了权限」（A-07）', async () => {
    makeTopic(1, { summaries: [{ text: '讨论了如何撤销了权限以及恢复方法', keywords: ['auth'] }] });
    makeTopic(2, { summaries: [{ text: '关于部署流水线的讨论', keywords: ['deploy'] }] });
    const service = new TopicSearchService({});
    const result = await service.search({ query: '权限撤销', mode: 'keyword', limit: 10 }, store.listTopics());
    expect(result.items.map(i => i.topicKey)).toEqual(['thread:oc_a:om_root1']);
    expect(result.effectiveMode).toBe('keyword');
    expect(result.degradedReasons).toEqual([]);
  });

  it('精确关键词/错误码高权重：exact keyword 压过正文散命中', async () => {
    makeTopic(1, { summaries: [{ text: '某个错误出现了 err_code_x 在正文里出现', keywords: [] }] });
    makeTopic(2, { summaries: [{ text: '排查记录', keywords: ['err_code_x'] }] });
    const service = new TopicSearchService({});
    const result = await service.search({ query: 'err_code_x', mode: 'keyword', limit: 10 }, store.listTopics());
    expect(result.items[0]!.topicKey).toBe('thread:oc_a:om_root2');
  });

  it('多词 AND：两个词都在场才命中', async () => {
    makeTopic(1, { summaries: [{ text: '只有部署相关的讨论', keywords: [] }] });
    makeTopic(2, { summaries: [{ text: '部署失败后执行了回滚脚本', keywords: [] }] });
    const service = new TopicSearchService({});
    const result = await service.search({ query: '部署 回滚', mode: 'keyword', limit: 10 }, store.listTopics());
    expect(result.items.map(i => i.topicKey)).toEqual(['thread:oc_a:om_root2']);
  });

  it('标题命中参与排序；命中摘要作为片段返回', async () => {
    makeTopic(1, { title: '跨 bot owner 讨论', summaries: [{ text: '内容无关', keywords: [] }] });
    const service = new TopicSearchService({});
    const result = await service.search({ query: 'owner', mode: 'keyword', limit: 10 }, store.listTopics());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.title).toBe('跨 bot owner 讨论');
    expect(result.items[0]!.matches).toEqual([]);
  });
});

describe('filters 与分页', () => {
  it('chatIds/来源时间窗只收窄候选；时间按来源消息时间而非摘要时间', async () => {
    makeTopic(1, { chatId: 'oc_a', summaries: [{ text: '部署问题' }], coverageStartAt: '2026-10-01T00:00:00Z', sourceThroughAt: '2026-10-02T00:00:00Z' });
    makeTopic(2, { chatId: 'oc_b', summaries: [{ text: '部署问题' }], coverageStartAt: '2026-10-28T00:00:00Z', sourceThroughAt: '2026-10-29T00:00:00Z' });
    const service = new TopicSearchService({});
    const narrowed = await service.search({ query: '部署', mode: 'keyword', limit: 10, filters: { chatIds: ['oc_b'] } }, store.listTopics());
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.items[0]!.topicKey).toBe('thread:oc_b:om_root2');
    const oldOnly = await service.search({ query: '部署', mode: 'keyword', limit: 10, filters: { sourceTo: '2026-10-15T00:00:00Z' } }, store.listTopics());
    expect(oldOnly.items.map(i => i.topicKey)).toEqual(['thread:oc_a:om_root1']);
  });

  it('分页：游标翻页；改查询/过滤后旧游标作废', async () => {
    for (let i = 1; i <= 3; i++) makeTopic(i, { summaries: [{ text: `部署记录 ${i}` }] });
    const service = new TopicSearchService({});
    const input = { query: '部署', mode: 'keyword' as const, limit: 2 };
    const page1 = await service.search(input, store.listTopics());
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await service.search({ ...input, cursor: page1.nextCursor }, store.listTopics());
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    await expect(service.search({ ...input, filters: { chatIds: ['oc_a'] }, cursor: page1.nextCursor }, store.listTopics()))
      .rejects.toThrow(TopicSearchValidationError);
  });

  it('输入校验：空查询/超长/limit 越界', async () => {
    const service = new TopicSearchService({});
    const candidates = store.listTopics();
    await expect(service.search({ query: '  ', mode: 'keyword', limit: 5 }, candidates)).rejects.toThrow(TopicSearchValidationError);
    await expect(service.search({ query: 'x'.repeat(201), mode: 'keyword', limit: 5 }, candidates)).rejects.toThrow(TopicSearchValidationError);
    await expect(service.search({ query: 'x', mode: 'keyword', limit: 0 }, candidates)).rejects.toThrow(TopicSearchValidationError);
    await expect(service.search({ query: 'x', mode: 'keyword', limit: 51 }, candidates)).rejects.toThrow(TopicSearchValidationError);
  });

  it('候选超过预算：partial + 未扫描计数，不静默宣称完整', async () => {
    const many: Topic[] = [];
    for (let i = 0; i < MAX_CANDIDATES + 5; i++) {
      // 直接构造内存对象，避免逐个落库的开销
      many.push({
        schemaVersion: 1, topicKey: `thread:oc_a:om_b${i}`, chatId: 'oc_a', rootMessageId: `om_b${i}`,
        title: `话题${i}`, accessPolicyRef: 'chat:oc_a', revision: 1,
        summaries: [{ id: `s${i}`, text: `部署记录${i}`, keywords: [], sourceMessageIds: [], updatedAt: T0, generatorKey: 'g' }],
        updatedAt: T0,
      });
    }
    const service = new TopicSearchService({});
    const result = await service.search({ query: '部署', mode: 'keyword', limit: 10 }, many);
    expect(result.coverage.state).toBe('partial');
    expect(result.coverage.unindexedKnownTopics).toBe(5);
  });
});

describe('向量与融合', () => {
  it('keyword 模式不请求向量（A-05）', async () => {
    makeTopic(1, { summaries: [{ text: '部署', embedding: [1, 0, 0, 0] }] });
    let embedCalls = 0;
    const service = new TopicSearchService({ embedQuery: async () => { embedCalls++; return (await embedderOk([1, 0, 0, 0])) as TopicEmbeddingResult; } });
    await service.search({ query: '部署', mode: 'keyword', limit: 5 }, store.listTopics());
    expect(embedCalls).toBe(0);
  });

  it('hybrid：向量通道参与并融合；每话题只返回一条', async () => {
    makeTopic(1, { title: '标题无关', summaries: [{ text: '完全无关的文本', embedding: [0.9, 0.1, 0, 0] }] });
    makeTopic(2, { title: '也不是这里', summaries: [{ text: '另一个无关内容', embedding: [0.1, 0.9, 0, 0] }] });
    const service = new TopicSearchService({ embedQuery: embedderOk([0.95, 0.05, 0, 0]) });
    const result = await service.search({ query: '随便什么查询词xyz', mode: 'hybrid', limit: 10 }, store.listTopics());
    expect(result.effectiveMode).toBe('hybrid');
    // 纯向量命中的话题也应出现（关键词零命中），排序第一
    expect(result.items[0]!.topicKey).toBe('thread:oc_a:om_root1');
    expect(new Set(result.items.map(i => i.topicKey)).size).toBe(result.items.length);
  });

  it('向量失败：降级关键词结果并标注，不整体失败（A-05）', async () => {
    makeTopic(1, { summaries: [{ text: '部署事件', keywords: ['deploy'] }] });
    const service = new TopicSearchService({ embedQuery: embedderFail });
    const result = await service.search({ query: '部署', mode: 'hybrid', limit: 5 }, store.listTopics());
    expect(result.effectiveMode).toBe('keyword');
    expect(result.degradedReasons).toContain('embedding_unavailable');
    expect(result.items).toHaveLength(1);
  });

  it('无 embedder 时 hybrid 请求标注 embedding_disabled', async () => {
    makeTopic(1, { summaries: [{ text: '部署事件' }] });
    const service = new TopicSearchService({});
    const result = await service.search({ query: '部署', mode: 'hybrid', limit: 5 }, store.listTopics());
    expect(result.effectiveMode).toBe('keyword');
    expect(result.degradedReasons).toContain('embedding_disabled');
  });

  it('向量空间不一致不混用：不同 modelKey 的候选被跳过', async () => {
    // 候选摘要带 openai-compatible/emb-1:4 向量；查询向量返回另一个空间的 modelKey
    makeTopic(1, { summaries: [{ text: '任意', embedding: [1, 0, 0, 0] }] });
    const service = new TopicSearchService({ embedQuery: embedderOk([1, 0, 0, 0], 'openai-compatible/emb-2:8') });
    const result = await service.search({ query: '任意', mode: 'hybrid', limit: 5 }, store.listTopics());
    expect(result.effectiveMode).toBe('hybrid'); // 向量通道存在但没有可用候选
    expect(result.items.map(i => i.topicKey)).toEqual(['thread:oc_a:om_root1']); // 关键词兜底命中
  });
});

describe('vector 纯函数', () => {
  it('cosine 相似度与 RRF 融合', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [0.5, 0.5])).toBeCloseTo(Math.SQRT1_2);
    const fused = fuseRankings(['a', 'b'], ['b', 'c']);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('a')!);
    expect(fused.get('b')!).toBeGreaterThan(fused.get('c')!);
  });

  it('vectorRecall 取每话题最高相似度摘要', () => {
    const topic: Topic = {
      schemaVersion: 1, topicKey: 'thread:oc_a:om_r', chatId: 'oc_a', rootMessageId: 'om_r',
      title: 't', accessPolicyRef: 'chat:oc_a', revision: 1, updatedAt: T0,
      summaries: [
        { id: 's1', text: 'a', keywords: [], sourceMessageIds: [], updatedAt: T0, generatorKey: 'g', embedding: { modelKey: 'm', contentHash: 'h', vector: [1, 0] } },
        { id: 's2', text: 'b', keywords: [], sourceMessageIds: [], updatedAt: T0, generatorKey: 'g', embedding: { modelKey: 'm', contentHash: 'h', vector: [0, 1] } },
      ],
    };
    const ranked = vectorRecall([topic], [0.9, 0.1], 'm');
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.summaryId).toBe('s1');
  });
});
