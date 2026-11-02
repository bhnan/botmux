import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TopicStore, type TopicCommit } from '../../src/topic/store.js';
import { encodeCursor } from '../../src/topic/source.js';
import { parseTopicSearchConfig } from '../../src/topic/config.js';

let directory: string, store: TopicStore, time: number;
const initial = '2026-10-01T00:00:00.000Z', key = 'thread:oc_a:om_root';
const profile = parseTopicSearchConfig({ models: { embed: { adapter: 'openai-embeddings', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST', dimensions: 2 } } }).models.embed;
beforeEach(() => {
  time = Date.parse(initial); directory = mkdtempSync(join(tmpdir(), 'topic-maintenance-'));
  store = new TopicStore(join(directory, 'topics.db'), () => time);
  store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: 'A', accessPolicyRef: 'dashboard' }, initial);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function add(operationId: string, now = initial): TopicCommit {
  const input: TopicCommit = { topicKey: key, expectedRevision: store.read(key)!.revision, operationId,
    mutations: [{ op: 'add', text: operationId, keywords: [operationId], sourceMessageIds: ['om_source'] }],
    verifiedMessageIds: ['om_source'], cursor: encodeCursor({ time: initial, ids: ['om_source'] }), generatorKey: 'fake', now, embeddingProfile: profile };
  expect(store.commit(input)).toBe('committed'); return input;
}
it('expires only summaries reaching TTL, including vectors/tasks, without resetting source dates/cursor/receipts', () => {
  const receipt = add('old');
  time += 86_400_000;
  const initialLease = store.jobs.acquire('owner', 30_000)!;
  const late = store.embeddings.claim(initialLease)!;
  expect(late.text).toBe('old');
  add('recent', '2026-10-02T00:00:00.000Z');
  store.observe(key, { createdAt: initial, latestAt: initial, checkedAt: initial });
  const before = store.read(key)!;
  const lease = store.jobs.acquire('owner', 30_000)!;
  expect(store.expireSummaries(lease, [key], 1, new Date(time).toISOString())).toBe(1);
  const after = store.read(key)!;
  expect(after.summaries.map(summary => summary.text)).toEqual(['recent']);
  expect(after.summarizedThroughCursor).toBe(before.summarizedThroughCursor);
  expect(after.topicCreatedAt).toBe(before.topicCreatedAt);
  expect(after.latestMessageAt).toBe(before.latestMessageAt);
  expect(store.commit(receipt)).toBe('duplicate');
  expect(() => store.embeddings.complete(late, [1, 0], late.model)).toThrow('stale_topic_embedding_claim');
  expect(store.embeddings.pending()).toBe(1);
  expect(store.expireSummaries(lease, [key], 1, new Date(time).toISOString())).toBe(0);
});
it('fences old ownership and late summary writers when retention changes during their model call', () => {
  add('old');
  const before = store.read(key)!;
  const late: TopicCommit = { topicKey: key, expectedRevision: before.revision, operationId: 'late', mutations: [{ op: 'add', text: 'resurrection', keywords: [], sourceMessageIds: ['om_source'] }], verifiedMessageIds: ['om_source'], cursor: before.summarizedThroughCursor!, generatorKey: 'fake', now: initial };
  const stale = store.jobs.acquire('old', 1)!;
  time += 86_400_000;
  const lease = store.jobs.acquire('new', 30_000)!;
  expect(() => store.expireSummaries(stale, [key], 1, new Date(time).toISOString())).toThrow('stale_topic_maintenance');
  expect(store.expireSummaries(lease, [key], null, new Date(time).toISOString())).toBe(0);
  store.expireSummaries(lease, [key], 1, new Date(time).toISOString());
  expect(store.commit(late)).toBe('conflict');
  expect(store.read(key)!.summaries).toEqual([]);
});
it('resumes bounded independent maintenance traversal after restart and wraps without starving later keys', () => {
  for (let i = 0; i < 5; i++) store.discover({ chatId: 'oc_b', rootMessageId: `om_${i}`, title: 'B', accessPolicyRef: 'dashboard' }, initial);
  const lease = store.jobs.acquire('owner', 30_000)!;
  const first = store.maintenancePage(lease, 'retention', 2).map(topic => topic.topicKey);
  store.close(); store = new TopicStore(join(directory, 'topics.db'), () => time);
  const second = store.maintenancePage(lease, 'retention', 2).map(topic => topic.topicKey);
  expect(second.some(key => first.includes(key))).toBe(false);
  expect(store.maintenancePage(lease, 'embedding', 2).map(topic => topic.topicKey)).toEqual(first);
  const third = store.maintenancePage(lease, 'retention', 2).map(topic => topic.topicKey);
  expect(new Set([...first, ...second, ...third]).size).toBe(6);
  expect(store.maintenancePage(lease, 'retention', 2)).toEqual([]);
  expect(store.maintenancePage(lease, 'retention', 2).map(topic => topic.topicKey)).toEqual(first);
  expect(store.keysForChats(['oc_a'])).toEqual([key]);
  expect(store.keysForChats([])).toEqual([]);
});
it('check timestamps alone preserve search snapshots while actual date observations invalidate them', () => {
  const before = store.generation();
  store.observe(key, { checkedAt: initial });
  expect(store.read(key)!.lastCheckedAt).toBe(initial);
  expect(store.generation()).toBe(before);
  store.observe(key, { checkedAt: initial, latestAt: initial });
  expect(store.generation()).toBeGreaterThan(before);
});
