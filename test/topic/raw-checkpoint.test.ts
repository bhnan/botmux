import { TopicSearchService } from '../../src/topic/search.js';
import { parseTopicSearchConfig } from '../../src/topic/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TopicStore } from '../../src/topic/store.js';
import { encodeCursor, TOPIC_SOURCE_CHECKPOINT_TTL_MS, type TopicSourceCheckpoint } from '../../src/topic/source.js';
import { openDatabaseSyncOrThrow } from '../../src/services/sqlite-compat.js';

let store: TopicStore, directory: string, now: number;
const at = '2026-10-01T00:00:00.000Z', key = 'thread:oc_a:om_root';
beforeEach(() => { now = Date.parse(at); directory = mkdtempSync(join(tmpdir(), 'topic-raw-ttl-')); store = new TopicStore(join(directory, 'topics.db'), () => now); store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: 'fixture', accessPolicyRef: 'dashboard' }, at); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const cursor = encodeCursor({ time: at, ids: ['om_first'] });
  store.commit({ topicKey: key, expectedRevision: 0, operationId: 'first', now: at, generatorKey: 'fake', mutations: [{ op: 'noop' }], verifiedMessageIds: [], cursor });
  const lease = store.jobs.acquire('owner', TOPIC_SOURCE_CHECKPOINT_TTL_MS * 3)!;
  store.jobs.admit(lease, { enabled: true, slot: 'first', topicKeys: [key], snapshot: '{}', limit: 1 });
  const claim = store.jobs.claim(lease, 1)!;
  const checkpoint: TopicSourceCheckpoint = { baseCursor: cursor, pending: [{ id: 'om_tail', text: 'sensitive offline tail', createdAt: at }], exhausted: true, seenTokens: [], startedAt: at, coverageStartAt: at };
  store.saveSourceProgress(claim, checkpoint);
  return { cursor, lease, claim, checkpoint };
}
it('raw tails expire independently of summaries, including after a terminal step budget and restart', () => {
  const f = fixture();
  store.settle(f.claim, { kind: 'source-progress', checkpoint: store.sourceCheckpoint(key), maxSteps: 1 });
  expect(store.jobs.list()[0].state).toBe('done');
  now += TOPIC_SOURCE_CHECKPOINT_TTL_MS + 1;
  const path = store.path; store.close(); store = new TopicStore(path, () => now);
  expect(store.sourceCheckpoint(key)).toBeNull();
  expect(store.read(key)!.summarizedThroughCursor).toBe(f.cursor);
  const db = openDatabaseSyncOrThrow(path);
  expect(db.prepare('SELECT COUNT(*) AS n FROM topic_source_scans').get()).toEqual({ n: 0 }); db.close();
});
it('bounded disabled-runtime maintenance removes old raw state even without anyone reading the topic', () => {
  const f = fixture(); now += TOPIC_SOURCE_CHECKPOINT_TTL_MS + 1;
  expect(store.purgeExpiredSourceCheckpoints(f.lease, 1)).toBe(1);
  expect(store.purgeExpiredSourceCheckpoints(f.lease, 1)).toBe(0);
  expect(store.read(key)!.summarizedThroughCursor).toBe(f.cursor);
});
it('late work cannot resurrect an expired tail after maintenance, or extend its lifetime by saving again', () => {
  const f = fixture(), pending = store.sourceCheckpoint(key)!;
  now += TOPIC_SOURCE_CHECKPOINT_TTL_MS / 2;
  store.saveSourceProgress(f.claim, pending);
  expect(store.sourceCheckpoint(key)!.expiresAt).toBe(pending.expiresAt);
  now += TOPIC_SOURCE_CHECKPOINT_TTL_MS;
  store.purgeExpiredSourceCheckpoints(f.lease);
  store.saveSourceProgress(f.claim, pending);
  expect(store.sourceCheckpoint(key)).toBeNull();
  expect(store.read(key)!.summarizedThroughCursor).toBe(f.cursor);
});
it('old schemas without an expiry fail safe by discarding temporary inputs, not durable knowledge', () => {
  const f = fixture(), path = store.path; store.close();
  const old = openDatabaseSyncOrThrow(path);
  old.exec('DROP INDEX topic_source_scans_expiry; ALTER TABLE topic_source_scans DROP COLUMN expires; PRAGMA user_version=8;'); old.close();
  store = new TopicStore(path, () => now);
  expect(store.sourceCheckpoint(key)).toBeNull(); expect(store.read(key)!.summarizedThroughCursor).toBe(f.cursor);
});

it('clearing raw input cannot misreport same-millisecond unsummarized messages as fully covered', async () => {
  const f = fixture();
  store.observe(key, { latestAt: at, checkedAt: at });
  store.settle(f.claim, { kind: 'source-progress', checkpoint: store.sourceCheckpoint(key), maxSteps: 1 });
  now += TOPIC_SOURCE_CHECKPOINT_TTL_MS + 1; store.purgeExpiredSourceCheckpoints(f.lease);
  const config = parseTopicSearchConfig({ enabled: true, llmModelRef: 'fake', models: { fake: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' } } });
  const search = new TopicSearchService(store, () => config, { embed: async () => [1] }, { now: () => now });
  expect((await search.search({ query: 'fixture', mode: 'keyword' }, { principal: 'owner', chatIds: null })).coverage.state).toBe('partial');
  store.jobs.admit(f.lease, { enabled: true, slot: 'next', topicKeys: [key], snapshot: '{}', limit: 1 });
  const next = store.jobs.claim(f.lease, 1)!;
  store.settle(next, { kind: 'source-progress', checkpoint: null, maxSteps: 1 });
  expect((await search.search({ query: 'fixture', mode: 'keyword' }, { principal: 'owner', chatIds: null })).coverage.state).toBe('complete');
});
