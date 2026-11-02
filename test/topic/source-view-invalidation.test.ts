import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { TopicStore } from '../../src/topic/store.js';
import { TopicRuntime } from '../../src/topic/runtime.js';
import { TopicScheduler } from '../../src/topic/scheduler.js';
import { TopicEmbeddingWorker } from '../../src/topic/embedding.js';
import { topicSummaryExecutor } from '../../src/topic/summary-updater.js';
import { parseTopicSearchConfig } from '../../src/topic/config.js';
import { encodeCursor, type TopicMessage } from '../../src/topic/source.js';
import type { TopicModelInput } from '../../src/topic/model-client.js';
import type { TopicSourceCheck } from '../../src/topic/source-review.js';
import { openDatabaseSyncOrThrow } from '../../src/services/sqlite-compat.js';

const key = 'thread:oc_a:om_root', at = '2026-10-01T00:00:00.000Z';
const original: TopicMessage = { id: 'om_evidence', createdAt: at, text: 'retained secret evidence' };
const later: TopicMessage = { id: 'om_later', createdAt: '2026-10-01T01:00:00.000Z', text: 'later fact' };
const config = parseTopicSearchConfig({ enabled: true, allowedChatIds: ['oc_a'], retryBaseMs: 100, llmModelRef: 'summary', models: {
  summary: { adapter: 'openai-chat', endpoint: 'https://offline.invalid', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' },
  embed: { adapter: 'openai-embeddings', endpoint: 'https://offline.invalid', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST', dimensions: 2 },
}, embedding: { enabled: true, modelRef: 'embed' } });
let directory: string, store: TopicStore, runtime: TopicRuntime, time: number;
let observation: TopicSourceCheck, closing: Array<{ close(): Promise<void> }>;
const signal = () => new AbortController().signal;
const view = () => runtime.sourceView(key, original.id, signal());
const cursor = encodeCursor({ time: at, ids: [original.id] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mutation(input: TopicModelInput) { return [{ op: 'add' as const, text: input.messages.map(m => m.text).join('; '), keywords: ['fact'], sourceMessageIds: input.messages.map(m => m.id) }]; }
const current = (kind: string): TopicMessage => kind === 'deleted' ? { ...original, text: '', deleted: true } : { ...original, text: 'corrected evidence' };
beforeEach(() => {
  time = Date.parse('2026-10-02T00:00:00Z'); closing = [];
  directory = mkdtempSync(join(tmpdir(), 'topic-source-view-'));
  store = new TopicStore(join(directory, 'topics.sqlite'), () => time);
  store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: 'fixture', accessPolicyRef: 'dashboard', coverageStartAt: at }, at);
  store.commit({ topicKey: key, expectedRevision: 0, operationId: 'initial', mutations: mutation({ title: '', messages: [original], summaries: [] }), verifiedMessageIds: [original.id], processedSources: [original], cursor, generatorKey: 'fake', now: at, embeddingProfile: config.models.embed });
  observation = { state: 'present', message: original };
  runtime = new TopicRuntime({ directory, config: () => config, now: () => time, sessions: () => [], daemons: () => [], proxy: async () => { throw new Error('unexpected transport'); }, check: async () => observation });
});
afterEach(async () => { for (const item of closing) await item.close(); await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function scheduler(model: (profile: any, input: TopicModelInput) => Promise<any>, page: () => Promise<any>) {
  const item = new TopicScheduler(store, () => ({ ...config, slot: 'next', snapshot: JSON.stringify(config) }), topicSummaryExecutor({ store, now: () => time, source: () => page, model: { summarize: model } }));
  closing.push(item); return item;
}
async function confirm(kind: string) {
  observation = kind === 'deleted' ? { state: 'deleted' } : { state: 'present', message: current(kind) };
  if (kind === 'deleted') await expect(view()).rejects.toThrow('topic_source_unavailable');
  else expect((await view()).message.text).toBe('corrected evidence');
}

it.each(['deleted', 'edited'])('a trusted %s view removes search evidence and queued vectors without acknowledging a cursor', async kind => {
  const before = store.read(key)!;
  await confirm(kind);
  expect((await runtime.service().search({ query: 'retained secret', mode: 'keyword' }, { principal: 'owner', chatIds: null })).items).toEqual([]);
  expect(store.read(key)).toMatchObject({ summaries: [], summarizedThroughCursor: cursor, sourceIncomplete: true });
  expect(store.read(key)!.revision).toBeGreaterThan(before.revision);
  expect(store.embeddings.pending()).toBe(0);
  const embed = vi.fn(async () => [1, 0]);
  const worker = new TopicEmbeddingWorker(store.embeddings, { embed }, () => config); closing.push(worker);
  worker.tick(store.jobs.acquire('vectors', 30_000)!); await worker.idle();
  expect(embed).not.toHaveBeenCalled();
  expect(store.commit({ topicKey: key, expectedRevision: before.revision, operationId: 'late', mutations: mutation({ title: '', messages: [original], summaries: [] }), verifiedMessageIds: [original.id], cursor, generatorKey: 'fake', now: at })).toBe('conflict');
});

it.each(['deleted', 'edited'])('a trusted %s observation fences in-flight summary/vector results, then rebuilds from verified source', async kind => {
  const started = deferred<void>(), summary = deferred<ReturnType<typeof mutation>>(), vector = deferred<number[]>();
  const model = vi.fn(async (_profile, input: TopicModelInput) => { started.resolve(); return summary.promise; });
  let messages = [original, later];
  const runner = scheduler(model, async () => ({ verifiedThread: true, hasMore: false, messages }));
  runner.tick(); await started.promise;
  const worker = new TopicEmbeddingWorker(store.embeddings, { embed: async () => vector.promise }, () => config); closing.push(worker);
  worker.tick(runner.currentLease()!);
  await confirm(kind);
  summary.resolve([{ op: 'add', text: 'stale result', keywords: ['fact'], sourceMessageIds: [original.id, later.id] }]);
  vector.resolve([1, 0]); await runner.idle(); await worker.idle();
  expect(store.read(key)).toMatchObject({ summaries: [], summarizedThroughCursor: cursor });
  expect(store.jobs.list()[0]).toMatchObject({ state: 'queued', error: 'topic_revision_conflict' });
  expect(store.embeddings.pending()).toBe(0);
  messages = [current(kind), later]; model.mockImplementation(async (_profile, input) => mutation(input));
  time += config.retryBaseMs; runner.tick(); await runner.idle();
  const rebuilt = store.read(key)!;
  expect(rebuilt.summaries).toHaveLength(1);
  expect(rebuilt.summaries[0].text).not.toContain('retained secret');
  expect(rebuilt.summaries[0].sourceMessageIds).toEqual(kind === 'deleted' ? [later.id] : [original.id, later.id]);
  expect(rebuilt.summaries[0].embedding).toBeUndefined();
  expect(store.sourceChanged(key, current(kind))).toBe(false);
  expect(rebuilt.sourceIncomplete).toBe(false);
});

it('a view edit during an old page read prevents that page from reaching the model and retries fresh', async () => {
  const page = deferred<any>(), entered = deferred<void>();
  const read = vi.fn(async () => { entered.resolve(); return page.promise; });
  const model = vi.fn(async (_profile, input: TopicModelInput) => mutation(input));
  const runner = scheduler(model, read); runner.tick(); await entered.promise;
  await confirm('edited'); page.resolve({ verifiedThread: true, hasMore: false, messages: [original, later] });
  await runner.idle(); expect(model).not.toHaveBeenCalled();
  expect(store.read(key)).toMatchObject({ summaries: [], summarizedThroughCursor: cursor });
  read.mockImplementation(async () => ({ verifiedThread: true, hasMore: false, messages: [current('edited'), later] }));
  time += config.retryBaseMs; runner.tick(); await runner.idle();
  expect(model).toHaveBeenCalledTimes(1);
  expect(store.read(key)!.summaries[0].text).toContain('corrected evidence');
});

it('reconciliation rolls back vector removal and tombstones if the final document write fails', async () => {
  const db = openDatabaseSyncOrThrow(join(directory, 'topics.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_observation BEFORE UPDATE ON topic_documents BEGIN SELECT RAISE(ABORT, 'offline failure'); END");
    observation = { state: 'deleted' }; await expect(view()).rejects.toThrow('offline failure');
    expect(store.read(key)!.summaries).toHaveLength(1); expect(store.embeddings.pending()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_tombstones').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER fail_observation'); await confirm('deleted');
    expect(store.read(key)!.summaries).toEqual([]); expect(store.embeddings.pending()).toBe(0);
  } finally { db.close(); }
});

it('unknown, mismatched ID/creation identity and cancelled observations never erase knowledge', async () => {
  const before = store.read(key)!;
  for (const result of [{ state: 'unknown' }, { state: 'present', message: { ...original, id: 'om_wrong' } }, { state: 'present', message: { ...original, createdAt: later.createdAt } }] as TopicSourceCheck[]) {
    observation = result; await expect(view()).rejects.toThrow();
    expect(store.read(key)).toEqual(before); expect(store.embeddings.pending()).toBe(1);
  }
  const abort = new AbortController(); abort.abort(); observation = { state: 'deleted' };
  await expect(runtime.sourceView(key, original.id, abort.signal)).rejects.toThrow();
  expect(store.read(key)).toEqual(before);
});

it('confirmed edits discard pending old raw tails but keep the successful cursor over reopen', async () => {
  const lease = store.jobs.acquire('checkpoint', 30_000)!;
  store.jobs.admit(lease, { enabled: true, slot: 'pending', topicKeys: [key], snapshot: JSON.stringify(config), limit: 1 });
  const claim = store.jobs.claim(lease, 1)!;
  store.saveSourceProgress(claim, { baseCursor: cursor, pending: [original], exhausted: true, seenTokens: [], startedAt: new Date(time).toISOString(), coverageStartAt: at });
  expect(store.sourceCheckpoint(key)?.pending).toHaveLength(1);
  await confirm('edited'); expect(store.sourceCheckpoint(key)).toBeNull();
  store.close(); store = new TopicStore(join(directory, 'topics.sqlite'), () => time);
  expect(store.read(key)).toMatchObject({ summaries: [], summarizedThroughCursor: cursor, sourceIncomplete: true });
  expect(store.sourceChanged(key, current('edited'))).toBe(true);
});

it('an already-returned source-progress result cannot restore a checkpoint or clear a newer invalidation', async () => {
  const lease = store.jobs.acquire('progress', 30_000)!;
  store.jobs.admit(lease, { enabled: true, slot: 'progress', topicKeys: [key], snapshot: JSON.stringify(config), limit: 1 });
  const claim = store.jobs.claim(lease, 1)!, revision = store.read(key)!.revision;
  await confirm('edited');
  expect(store.settle(claim, { kind: 'source-progress', expectedRevision: revision, checkpoint: null, maxSteps: 1 })).toBe('conflict');
  expect(store.read(key)!.sourceIncomplete).toBe(true);
  expect(store.jobs.list()[0].state).toBe('running');
});
