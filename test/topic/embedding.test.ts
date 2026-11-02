import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicStore } from '../../src/topic/store.js';
import { encodeCursor } from '../../src/topic/source.js';
import { parseTopicSearchConfig, type TopicModelProfile } from '../../src/topic/config.js';
import { TopicEmbeddingWorker, summaryVector, cosine } from '../../src/topic/embedding.js';
import { topicModelKey } from '../../src/topic/model-client.js';

let directory: string, store: TopicStore, time: number, profile: TopicModelProfile;
const key = 'thread:oc_a:om_root', now = '2026-10-01T00:00:00.000Z';
beforeEach(() => {
  time = Date.parse(now); directory = mkdtempSync(join(tmpdir(), 'topic-embedding-'));
  store = new TopicStore(join(directory, 'topics.db'), () => time);
  store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: 'A', accessPolicyRef: 'dashboard' }, now);
  profile = parseTopicSearchConfig({ models: { embed: { adapter: 'openai-embeddings', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST', dimensions: 2 } } }).models.embed;
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function add(withEmbedding = true) {
  store.commit({ topicKey: key, expectedRevision: store.read(key)!.revision, operationId: 'one',
    mutations: [{ op: 'add', text: 'fact', keywords: ['key'], sourceMessageIds: ['om_source'] }],
    verifiedMessageIds: ['om_source'], cursor: encodeCursor({ time: now, ids: ['om_source'] }), generatorKey: 'fake', now,
    ...(withEmbedding ? { embeddingProfile: profile } : {}) });
  return store.read(key)!.summaries[0];
}
it('atomically queues changed summaries and retries embedding independently without resummarizing', () => {
  add(); const cursor = store.read(key)!.summarizedThroughCursor;
  const lease = store.jobs.acquire('owner', 60_000)!;
  const first = store.embeddings.claim(lease)!; store.embeddings.fail(first);
  expect(store.embeddings.claim(lease)).toBeNull();
  time += 2000;
  const retry = store.embeddings.claim(lease)!;
  expect(retry.attempt).toBe(2);
  expect(store.embeddings.complete(retry, [1, 0], topicModelKey(profile))).toBe(true);
  expect(store.read(key)!.summarizedThroughCursor).toBe(cursor);
  expect(store.read(key)!.summaries).toHaveLength(1);
  expect(store.embeddings.pending()).toBe(0);
});
it('disabled embeddings create no tasks and retained summaries can later be reindexed outside update scope', () => {
  add(false); expect(store.embeddings.pending()).toBe(0);
  const lease = store.jobs.acquire('owner', 60_000)!;
  expect(store.embeddings.reindex(lease, store.list(), profile)).toBe(1);
  expect(store.embeddings.claim(lease)?.topic).toBe(key);
});
it('keyword-only updates keep vectors and changed text invalidates both vector and late work', () => {
  const summary = add(), lease = store.jobs.acquire('owner', 60_000)!;
  const claim = store.embeddings.claim(lease)!;
  store.embeddings.complete(claim, [1, 0], topicModelKey(profile));
  function update(operationId: string, text: string) {
    store.commit({ topicKey: key, expectedRevision: store.read(key)!.revision, operationId,
      mutations: [{ op: 'update', id: summary.id, text, keywords: [operationId], sourceMessageIds: ['om_source'] }], verifiedMessageIds: [], cursor: store.read(key)!.summarizedThroughCursor!, generatorKey: 'fake', now, embeddingProfile: profile });
  }
  update('keywords', summary.text); expect(store.embeddings.claim(lease)).toBeNull();
  expect(summaryVector(store.read(key)!.summaries[0], topicModelKey(profile), 2)).toEqual([1, 0]);
  update('text', 'changed'); const late = store.embeddings.claim(lease)!;
  update('text_again', 'changed again');
  expect(() => store.embeddings.complete(late, [1, 0], topicModelKey(profile))).toThrow('stale_topic_embedding_claim');
  expect(store.read(key)!.summaries[0].embedding).toBeUndefined();
});
it('switching embedding model requeues persisted content and drops an old-model completion', () => {
  add(); const lease = store.jobs.acquire('owner', 60_000)!, first = store.embeddings.claim(lease)!;
  const next = { ...profile, version: '2' };
  store.embeddings.reindex(lease, store.list(), next);
  expect(() => store.embeddings.complete(first, [1, 0], topicModelKey(next))).toThrow('stale_topic_embedding_claim');
  const claim = store.embeddings.claim(lease)!;
  store.embeddings.complete(claim, [0, 1], topicModelKey(next));
  expect(summaryVector(store.read(key)!.summaries[0], topicModelKey(profile), 2)).toBeNull();
  expect(summaryVector(store.read(key)!.summaries[0], topicModelKey(next), 2)).toEqual([0, 1]);
});
it('recovers an in-flight embedding after process restart and fences the previous owner', () => {
  add(); const stale = store.embeddings.claim(store.jobs.acquire('old', 100)!)!;
  store.close(); store = new TopicStore(join(directory, 'topics.db'), () => time); time += 100;
  const lease = store.jobs.acquire('new', 100)!, fresh = store.embeddings.claim(lease)!;
  expect(() => store.embeddings.complete(stale, [1, 0], topicModelKey(profile))).toThrow('stale_topic_embedding_claim');
  expect(store.embeddings.complete(fresh, [1, 0], topicModelKey(profile))).toBe(true);
});
it('deletion while an embedding runs cannot recreate the removed summary', () => {
  add(); const claim = store.embeddings.claim(store.jobs.acquire('owner', 1000)!)!;
  store.invalidate(key, ['om_source'], now);
  expect(store.embeddings.complete(claim, [1, 0], topicModelKey(profile))).toBe(false);
  expect(store.read(key)!.summaries).toEqual([]);
});
it('worker drains already queued embedding work when enrichment is disabled, with no new source reads', async () => {
  add(); const model = { embed: vi.fn().mockResolvedValue([1, 0]) };
  const config = parseTopicSearchConfig({ embedding: { enabled: true, modelRef: 'embed' }, models: { embed: profile }, allowedChatIds: [] });
  const worker = new TopicEmbeddingWorker(store.embeddings, model, () => config);
  worker.tick(store.jobs.acquire('owner', 1000)!); await worker.idle();
  expect(model.embed).toHaveBeenCalledTimes(1); expect(store.embeddings.pending()).toBe(0);
  await worker.close();
});
it('rejects invalid or stale vectors and computes bounded cosine without overflow', () => {
  add(); const claim = store.embeddings.claim(store.jobs.acquire('owner', 1000)!)!;
  expect(() => store.embeddings.complete(claim, [0, 0], topicModelKey(profile))).toThrow('invalid_topic_embedding');
  expect(() => store.embeddings.complete(claim, [Infinity, 0], topicModelKey(profile))).toThrow('invalid_topic_embedding');
  expect(cosine([1e300, 0], [1e300, 0])).toBeCloseTo(1);
  expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  expect(cosine([1], [1, 0])).toBe(0);
});
it('a text update with embedding disabled still rejects an already running vector by content hash', () => {
  const summary = add(), lease = store.jobs.acquire('owner', 1000)!, claim = store.embeddings.claim(lease)!;
  store.commit({ topicKey: key, expectedRevision: store.read(key)!.revision, operationId: 'text-with-embedding-off',
    mutations: [{ op: 'update', id: summary.id, text: 'changed with embedding disabled', keywords: [], sourceMessageIds: ['om_source'] }],
    verifiedMessageIds: [], cursor: store.read(key)!.summarizedThroughCursor!, generatorKey: 'fake', now });
  expect(store.embeddings.complete(claim, [1, 0], topicModelKey(profile))).toBe(false);
  expect(store.read(key)!.summaries[0].embedding).toBeUndefined();
});
it('pauses persisted retries on the independent embedding switch and resumes without losing the queue', async () => {
  add(); const model = { embed: vi.fn().mockRejectedValueOnce(new Error('offline provider failure')).mockResolvedValue([1, 0]) };
  const config = parseTopicSearchConfig({ embedding: { enabled: true, modelRef: 'embed' }, models: { embed: profile } });
  const lease = store.jobs.acquire('owner', 60_000)!;
  const worker = new TopicEmbeddingWorker(store.embeddings, model, () => config);
  worker.tick(lease); await worker.idle(); expect(model.embed).toHaveBeenCalledTimes(1);
  config.embedding.enabled = false; time += 2001;
  worker.tick(lease); await worker.idle();
  expect(model.embed).toHaveBeenCalledTimes(1); expect(store.embeddings.pending()).toBe(1);
  expect(store.read(key)!.summaries[0].embedding).toBeUndefined();
  config.embedding.enabled = true;
  worker.tick(lease); await worker.idle();
  expect(model.embed).toHaveBeenCalledTimes(2); expect(store.embeddings.pending()).toBe(0);
  expect(store.read(key)!.summaries[0].embedding?.vector).toEqual([1, 0]);
  await worker.close();
});
it('an independent switch change between claim and send pauses rather than drops the task', async () => {
  add(); const model = { embed: vi.fn() };
  const config = parseTopicSearchConfig({ embedding: { enabled: true, modelRef: 'embed' }, models: { embed: profile } });
  let reads = 0;
  const worker = new TopicEmbeddingWorker(store.embeddings, model, () => { if (++reads === 2) config.embedding.enabled = false; return config; });
  const lease = store.jobs.acquire('owner', 60_000)!; worker.tick(lease); await worker.idle();
  expect(model.embed).not.toHaveBeenCalled(); expect(store.embeddings.pending()).toBe(1);
  expect(store.embeddings.claim(lease)?.text).toBe('fact');
  await worker.close();
});
