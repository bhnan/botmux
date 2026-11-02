import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TopicStore, contentHash, type TopicCommit } from '../../src/topic/store.js';
import { encodeCursor } from '../../src/topic/source.js';

let store: TopicStore;
let directory: string;
const key = 'thread:oc_a:om_root';
const now = '2026-10-01T00:00:00.000Z';
const seed = { chatId: 'oc_a', rootMessageId: 'om_root', title: '讨论', accessPolicyRef: 'dashboard' };
function commit(overrides: Partial<TopicCommit> = {}): TopicCommit {
  return {
    topicKey: key, expectedRevision: store.read(key)!.revision, operationId: 'batch-1',
    mutations: [{ op: 'add', text: '事实一', keywords: ['关键词'], sourceMessageIds: ['om_message'] }],
    verifiedMessageIds: ['om_message'], cursor: encodeCursor({ time: now, ids: ['om_message'] }),
    generatorKey: 'fake-provider/v1', now, ...overrides,
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'topic-independent-'));
  store = new TopicStore(join(directory, 'topics.db'));
  store.discover(seed, now);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

it('persists successful summaries and idempotency across restart, without a Session', () => {
  const input = commit();
  expect(store.commit(input)).toBe('committed');
  store.close(); store = new TopicStore(join(directory, 'topics.db'));
  expect(store.commit(input)).toBe('duplicate');
  expect(store.read(key)!.summaries).toHaveLength(1);
  expect(store.read(key)!.summarizedThroughCursor).toBe(input.cursor);
});
it('serializes competing readers and rejects stale add instead of duplicating it', () => {
  const other = new TopicStore(store.path);
  try {
    const first = commit(), second = commit({ operationId: 'competing' });
    expect(other.commit(first)).toBe('committed');
    expect(store.commit(second)).toBe('conflict');
    expect(store.read(key)!.summaries).toHaveLength(1);
  } finally { other.close(); }
});
it('rolls back the entire batch if a later mutation has an invalid source', () => {
  const input = commit();
  input.mutations.push({ op: 'add', text: 'invalid', keywords: [], sourceMessageIds: ['om_other_topic'] });
  expect(() => store.commit(input)).toThrow('invalid_summary_source');
  expect(store.read(key)!.summaries).toEqual([]);
  expect(store.read(key)!.summarizedThroughCursor).toBeUndefined();
  expect(store.commit(commit())).toBe('committed');
});
it('observed source dates progress without falsely acknowledging failed summarization', () => {
  store.commit(commit());
  const cursor = store.read(key)!.summarizedThroughCursor;
  const topic = store.observe(key, { createdAt: now, latestAt: '2026-10-03T00:00:00Z', checkedAt: '2026-10-04T00:00:00Z' });
  expect(topic.latestMessageAt).toBe('2026-10-03T00:00:00.000Z');
  expect(topic.summarizedThroughCursor).toBe(cursor);
  expect(topic.topicCreatedAt).toBe(now);
});
it('noop advances the message boundary without creating a fake summary', () => {
  const input = commit({ mutations: [{ op: 'noop' }] });
  store.commit(input);
  expect(store.read(key)!.summaries).toEqual([]);
  expect(store.read(key)!.summarizedThroughCursor).toBe(input.cursor);
});
it('keeps same-millisecond processed ids rather than regressing the cursor set', () => {
  store.commit(commit());
  expect(() => store.commit(commit({ operationId: 'batch-2', cursor: encodeCursor({ time: now, ids: ['om_new'] }) })))
    .toThrow('cursor_regressed');
});
it('deletion prevents both late CAS and a freshly retried model result from resurrecting a source', () => {
  const late = commit();
  store.invalidate(key, ['om_message'], now);
  expect(store.commit(late)).toBe('conflict');
  expect(() => store.commit(commit())).toThrow('deleted_summary_source');
});
it('invalidates changed-text vectors but keeps vectors through keyword-only updates', () => {
  store.commit(commit());
  const summary = store.read(key)!.summaries[0];
  const embedding = { modelKey: 'fake/v1/2', contentHash: contentHash(summary.text), vector: [1, 0] };
  expect(store.saveEmbedding(key, summary.id, embedding)).toBe(true);
  store.commit(commit({ operationId: 'keywords', mutations: [{ op: 'update', id: summary.id, text: summary.text, keywords: ['new'], sourceMessageIds: ['om_message'] }] }));
  expect(store.read(key)!.summaries[0].embedding).toEqual(embedding);
  store.commit(commit({ operationId: 'text', mutations: [{ op: 'update', id: summary.id, text: 'changed', keywords: [], sourceMessageIds: ['om_message'] }] }));
  expect(store.read(key)!.summaries[0].embedding).toBeUndefined();
  expect(store.saveEmbedding(key, summary.id, embedding)).toBe(false);
});
it('does not transfer source summaries when a session relays or forks', () => {
  store.commit(commit());
  store.discover({ ...seed, chatId: 'oc_b' }, now);
  store.discover({ ...seed, rootMessageId: 'om_fork' }, now);
  expect(store.list().map(topic => topic.summaries.length).sort()).toEqual([0, 0, 1]);
});
it('upgrades a content-only database without resetting existing content and rejects newer unknown schemas', async () => {
  const { openDatabaseSyncOrThrow } = await import('../../src/services/sqlite-compat.js');
  store.commit(commit());
  const original = store.read(key);
  const path = store.path; store.close();
  const legacy = openDatabaseSyncOrThrow(path);
  legacy.exec('DROP TABLE topic_jobs; DROP TABLE topic_batches; DROP TABLE topic_lease; PRAGMA user_version=1;');
  legacy.close();
  store = new TopicStore(path);
  expect(store.read(key)).toEqual(original);
  expect(store.jobs.list()).toEqual([]);
  const futurePath = join(directory, 'future.db');
  const future = openDatabaseSyncOrThrow(futurePath); future.exec('PRAGMA user_version=99;'); future.close();
  expect(() => new TopicStore(futurePath)).toThrow('unsupported_topic_schema');
});
