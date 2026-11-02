import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicStore, contentHash } from '../../src/topic/store.js';
import { TopicSearchService, parseTopicSearchRequest } from '../../src/topic/search.js';
import { parseTopicSearchConfig, type TopicSearchConfig } from '../../src/topic/config.js';
import { encodeCursor } from '../../src/topic/source.js';
import { topicModelKey } from '../../src/topic/model-client.js';

let directory: string, store: TopicStore, config: TopicSearchConfig, model: { embed: ReturnType<typeof vi.fn> }, time: number;
const scope = { principal: 'owner-session', chatIds: null };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'topic-search-')); store = new TopicStore(join(directory, 'topics.db'));
  time = Date.parse('2026-10-15T00:00:00Z');
  config = parseTopicSearchConfig({ enabled: true, allowedChatIds: ['oc_update_only'], llmModelRef: 'summary', models: {
    summary: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' },
    embed: { adapter: 'openai-embeddings', endpoint: 'https://offline.invalid/v1', model: 'fake-embed', credentialRef: 'env:BOTMUX_TOPIC_EMBED', dimensions: 2 },
  } });
  model = { embed: vi.fn().mockResolvedValue([1, 0]) };
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });
function add(root: string, text: string, chat = 'oc_historical', keywords: string[] = []) {
  const topic = store.discover({ chatId: chat, rootMessageId: `om_${root}`, larkThreadId: `omt_${root}`, title: `topic ${root}`, accessPolicyRef: 'dashboard' }, new Date(time).toISOString());
  store.commit({ topicKey: topic.topicKey, expectedRevision: topic.revision, operationId: 'initial', mutations: [{ op: 'add', text, keywords, sourceMessageIds: [`om_source_${root}`] }], verifiedMessageIds: [`om_source_${root}`], cursor: encodeCursor({ time: '2026-10-01T00:00:00Z', ids: [`om_source_${root}`] }), generatorKey: 'fake', now: new Date(time).toISOString() });
  return store.read(topic.topicKey)!;
}
function service(options: ConstructorParameters<typeof TopicSearchService>[3] = {}) { return new TopicSearchService(store, () => config, model, { now: () => time, ...options }); }
function query(query = 'owner', patch: Record<string, unknown> = {}) { return { query, mode: 'keyword', ...patch }; }
it('searches retained summaries outside update scope and never calls a model in keyword mode', async () => {
  const topic = add('old', '跨应用 owner 身份需要转换', 'oc_removed', ['owner']);
  const response = await service().search(query(), scope);
  expect(response.items.map(item => item.topicKey)).toEqual([topic.topicKey]);
  expect(model.embed).not.toHaveBeenCalled();
  expect(response.items[0].url).toContain('open_thread_id=omt_old');
  expect(JSON.stringify(response)).not.toContain('credentialRef');
  expect(JSON.stringify(response)).not.toContain('embedding');
});
it('ranks Chinese multi-term matches and exact entity/error codes above a partial match', async () => {
  add('partial', 'owner information');
  const exact = add('exact', '跨应用 open_id 必须转换，否则报 E_OWNER_SCOPE', 'oc_historical', ['owner', 'E_OWNER_SCOPE']);
  add('other', '应用发布流程');
  expect((await service().search(query('跨应用 owner E_OWNER_SCOPE'), scope)).items[0].topicKey).toBe(exact.topicKey);
});
it('applies authorization before candidate limits so hidden topics cannot squeeze out permitted matches', async () => {
  add('aaa', 'owner secret', 'oc_hidden'); add('aab', 'owner secret', 'oc_hidden');
  const allowed = add('zzz', 'owner permitted', 'oc_visible');
  const response = await service({ maxTopics: 1, maxSummaries: 1 }).search(query(), { principal: 'limited', chatIds: ['oc_visible'] });
  expect(response.items.map(item => item.topicKey)).toEqual([allowed.topicKey]);
  expect(response.coverage.examinedTopics).toBe(1);
  expect(JSON.stringify(response)).not.toContain('oc_hidden');
  await expect(service().search(query('owner', { filters: { chatIds: ['oc_hidden'] } }), { principal: 'limited', chatIds: ['oc_visible'] })).rejects.toMatchObject({ status: 403 });
});
it('supports date-only queries with independent source-created and observed-latest bases, never summary update time', async () => {
  const old = add('old', 'irrelevant text'), newer = add('new', 'another text');
  store.observe(old.topicKey, { createdAt: '2020-01-01T00:00:00Z', latestAt: '2026-10-14T00:00:00Z', checkedAt: new Date(time).toISOString() });
  store.observe(newer.topicKey, { createdAt: '2026-10-10T00:00:00Z', latestAt: '2026-10-10T00:00:00Z', checkedAt: new Date(time).toISOString() });
  const search = service(); const from = '2026-10-12T00:00:00Z';
  expect((await search.search(query('', { filters: { timeBasis: 'latestMessage', from } }), scope)).items.map(t => t.topicKey)).toEqual([old.topicKey]);
  expect((await search.search(query('', { filters: { timeBasis: 'topicCreated', from } }), scope)).items).toEqual([]);
  expect(model.embed).not.toHaveBeenCalled();
});
it('does not pretend unknown source timestamps equal the summary timestamp', async () => {
  add('unknown', 'owner');
  const response = await service().search(query('', { filters: { timeBasis: 'topicCreated', from: '2026-01-01T00:00:00Z' } }), scope);
  expect(response.items).toEqual([]); expect(response.coverage).toMatchObject({ state: 'partial', unknownDateTopics: 1 });
});
it('maps legacy sourceFrom/sourceTo to observed latest only', () => {
  expect(parseTopicSearchRequest({ query: '', sourceFrom: '2026-01-01T00:00:00+08:00' }).filters).toMatchObject({ timeBasis: 'latestMessage', from: '2025-12-31T16:00:00.000Z' });
  expect(() => parseTopicSearchRequest({ query: '', filters: { sourceFrom: '2026-01-01T00:00:00Z', timeBasis: 'topicCreated' } })).toThrow();
});
it.each([{ query: '' }, { query: 'x'.repeat(513) }, { query: 'x', limit: 51 }, { query: 'x', mode: 'custom' }, { query: 'x', filters: { from: '2026-02-30T00:00:00Z' } }, { query: 'x', filters: { from: '2026-10-10T00:00:00Z', to: '2026-01-01T00:00:00Z' } }])('rejects invalid query contracts', raw => {
  expect(() => parseTopicSearchRequest(raw)).toThrow();
});
it('hybrid fuses lexical and semantic ranks and deduplicates topic results', async () => {
  const lexical = add('lexical', 'owner'), semantic = add('semantic', 'identity boundary');
  config.embedding = { enabled: true, modelRef: 'embed' };
  for (const [topic, vector] of [[lexical, [0, 1]], [semantic, [1, 0]]] as const) {
    const summary = topic.summaries[0]; store.saveEmbedding(topic.topicKey, summary.id, { modelKey: topicModelKey(config.models.embed), contentHash: contentHash(summary.text), vector: [...vector] });
  }
  const result = await service().search(query('owner', { mode: 'hybrid' }), scope);
  expect(result.effectiveMode).toBe('hybrid');
  expect(new Set(result.items.map(item => item.topicKey))).toEqual(new Set([lexical.topicKey, semantic.topicKey]));
  expect(model.embed).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('vector');
});
it('ignores stale model versions and degrades without exposing provider failures', async () => {
  const topic = add('one', 'owner'); config.embedding = { enabled: true, modelRef: 'embed' };
  store.saveEmbedding(topic.topicKey, topic.summaries[0].id, { modelKey: 'old-version', contentHash: contentHash('owner'), vector: [1, 0] });
  let result = await service().search(query('owner', { mode: 'auto' }), scope);
  expect(result.effectiveMode).toBe('keyword'); expect(result.degradedReasons).toContain('embedding_partial');
  model.embed.mockRejectedValue(new Error('provider secret failure'));
  result = await service().search(query('owner', { mode: 'hybrid' }), scope);
  expect(result.items).toHaveLength(1); expect(result.degradedReasons).toEqual(['embedding_unavailable']);
});
it('paginates a stable signed snapshot bound to principal, filters, mode, limit and index generation', async () => {
  for (const id of ['a', 'b', 'c']) add(id, 'owner');
  const search = service(), first = await search.search(query('owner', { limit: 1 }), scope);
  expect(first.nextCursor).not.toBeNull();
  const request = query('owner', { limit: 1, cursor: first.nextCursor });
  const second = await search.search(request, scope);
  expect(second.items[0].topicKey).not.toBe(first.items[0].topicKey);
  await expect(search.search(request, { ...scope, principal: 'other' })).rejects.toMatchObject({ status: 400 });
  await expect(search.search({ ...request, limit: 2 }, scope)).rejects.toMatchObject({ status: 400 });
  await expect(search.search({ ...request, query: 'different' }, scope)).rejects.toMatchObject({ status: 400 });
  await expect(search.search({ ...request, cursor: first.nextCursor + 'x' }, scope)).rejects.toMatchObject({ status: 400 });
  add('d', 'owner'); await expect(search.search(request, scope)).rejects.toMatchObject({ status: 400 });
});
it('expires snapshots and never treats a cursor as additional authority', async () => {
  add('a', 'owner'); add('b', 'owner'); const search = service({ cursorTtlMs: 100 });
  const first = await search.search(query('owner', { limit: 1 }), scope); time += 100;
  await expect(search.search(query('owner', { limit: 1, cursor: first.nextCursor }), scope)).rejects.toMatchObject({ status: 400 });
});
it('returns explicit partial coverage when authorized candidate budget is exhausted', async () => {
  add('a', 'owner'); add('b', 'owner');
  const result = await service({ maxTopics: 1 }).search(query(), scope);
  expect(result.items).toHaveLength(1); expect(result.coverage).toMatchObject({ state: 'partial', budgetLimited: true });
});
it('caps query embedding latency even if an injected provider ignores cancellation', async () => {
  vi.useFakeTimers(); add('a', 'owner'); config.embedding = { enabled: true, modelRef: 'embed' };
  model.embed.mockImplementation(() => new Promise(() => {}));
  const result = service({ budgetMs: 30 }).search(query('owner', { mode: 'hybrid' }), scope);
  await vi.advanceTimersByTimeAsync(31);
  expect((await result).degradedReasons).toEqual(['embedding_unavailable']);
});
it('requires authenticated authority and rejects disabled search without touching the model', async () => {
  await expect(service().search(query(), { principal: '', chatIds: null })).rejects.toMatchObject({ status: 401 });
  config.enabled = false;
  await expect(service().search(query(), scope)).rejects.toMatchObject({ status: 403 });
  expect(model.embed).not.toHaveBeenCalled();
});
