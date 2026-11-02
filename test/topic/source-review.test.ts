import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicStore } from '../../src/topic/store.js';
import { TopicScheduler } from '../../src/topic/scheduler.js';
import { topicSummaryExecutor } from '../../src/topic/summary-updater.js';
import { parseTopicSearchConfig, type TopicSearchConfig } from '../../src/topic/config.js';
import { encodeCursor } from '../../src/topic/source.js';
import type { TopicClaim } from '../../src/topic/jobs.js';
import type { TopicSourceCheck } from '../../src/topic/source-review.js';

let directory: string, store: TopicStore, now: number, config: TopicSearchConfig, runtimes: TopicScheduler[];
const old = '2026-09-01T00:00:00.000Z';
beforeEach(() => {
  now = Date.parse('2026-11-01T00:00:00.000Z'); directory = mkdtempSync(join(tmpdir(), 'topic-source-review-'));
  store = new TopicStore(join(directory, 'topics.db'), () => now); runtimes = [];
  config = parseTopicSearchConfig({ enabled: true, allowedChatIds: ['oc_a'], llmModelRef: 'fake', models: { fake: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' } }, maxHistoricalChecksPerRun: 2 });
});
afterEach(async () => { for (const runtime of runtimes) await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
function seed(index: number, date = old) {
  const topic = store.discover({ chatId: 'oc_a', rootMessageId: `om_${index}`, title: 'old fact', accessPolicyRef: 'dashboard' }, date);
  const message = { id: `om_${index}`, text: 'fact', createdAt: date };
  store.commit({ topicKey: topic.topicKey, expectedRevision: topic.revision, operationId: 'initial', now: date, generatorKey: 'fake', verifiedMessageIds: [message.id], processedSources: [message], cursor: encodeCursor({ time: date, ids: [message.id] }), mutations: [{ op: 'add', text: 'old fact', keywords: ['fact'], sourceMessageIds: [message.id] }] });
  return topic.topicKey;
}
function batch(slot: string): TopicClaim[] {
  const lease = store.jobs.acquire('owner', 60_000)!;
  store.jobs.admit(lease, { enabled: true, slot, topicKeys: store.keysForChats(['oc_a']), snapshot: JSON.stringify(config), limit: 20 });
  const result: TopicClaim[] = []; let claim: TopicClaim | null;
  while ((claim = store.jobs.claim(lease, 20))) result.push(claim);
  return result;
}
it('reserves one global historical budget across all topics/retries and resumes receipts after restart', () => {
  for (let i = 0; i < 6; i++) seed(i);
  const claims = batch('first');
  const first = claims.flatMap(claim => store.reviews.pending(claim, config));
  expect(first).toHaveLength(2);
  expect(first.every(candidate => candidate.kind === 'historical')).toBe(true);
  const claim = claims.find(claim => claim.job.topicKey === first[0].topic)!;
  store.reviews.finish(claim, first[0]);
  store.close(); store = new TopicStore(join(directory, 'topics.db'), () => now);
  expect(claims.flatMap(claim => store.reviews.pending(claim, config))).toEqual([first[1]]);
  for (const claim of claims) store.settle(claim, null);
  now += 86_400_000;
  const next = batch('second').flatMap(claim => store.reviews.pending(claim, config));
  expect(next).toHaveLength(2);
  expect(next.some(candidate => first.some(old => old.message === candidate.message))).toBe(false);
});
it('recent overlap checks have a separate bounded budget and do not steal the historical allowance', () => {
  seed(1, new Date(now - 3_600_000).toISOString()); seed(2); seed(3); seed(4);
  const pending = batch('first').flatMap(claim => store.reviews.pending(claim, config));
  expect(pending.filter(candidate => candidate.kind === 'recent')).toHaveLength(1);
  expect(pending.filter(candidate => candidate.kind === 'historical')).toHaveLength(2);
});
it('does not reserve non-referenced/noop sources or expired summaries, and rejects stale review completion', () => {
  const key = seed(1), claims = batch('first'), candidate = store.reviews.pending(claims[0], config)[0];
  now += 60_000; const lease = store.jobs.acquire('next', 60_000)!;
  expect(() => store.reviews.finish(claims[0], candidate)).toThrow('stale_topic_claim');
  store.expireSummaries(lease, [key], 1, new Date(now).toISOString());
  const recovered = store.jobs.claim(lease, 20)!; store.settle(recovered, null);
  store.jobs.release(lease);
  expect(batch('second').flatMap(claim => store.reviews.pending(claim, config))).toEqual([]);
});
it.each(['deleted', 'unknown'] as const)('real updater checks an absent historical source and treats %s correctly without advancing its cursor', async state => {
  const key = seed(1), cursor = store.read(key)!.summarizedThroughCursor;
  const check = vi.fn(async (): Promise<TopicSourceCheck> => ({ state }));
  const summarize = vi.fn();
  const execute = topicSummaryExecutor({ store, now: () => now, check, model: { summarize }, source: () => async () => ({ messages: [], hasMore: false, verifiedThread: true }) });
  const runtime = new TopicScheduler(store, () => ({ ...config, slot: 'one', snapshot: JSON.stringify(config) }), execute); runtimes.push(runtime);
  runtime.tick(); await runtime.idle();
  expect(check).toHaveBeenCalledTimes(1);
  expect(store.read(key)!.summaries).toHaveLength(state === 'deleted' ? 0 : 1);
  expect(store.read(key)!.summarizedThroughCursor).toBe(cursor);
  expect(summarize).not.toHaveBeenCalled();
  expect(store.jobs.list()[0].state).toBe('done');
});
it('invalidates checked edited evidence before a failed model, then rebuilds with the successful cursor unchanged', async () => {
  const key = seed(1), cursor = store.read(key)!.summarizedThroughCursor;
  const edited = { id: 'om_1', text: 'new fact', createdAt: old };
  const check = vi.fn(async (): Promise<TopicSourceCheck> => ({ state: 'present', message: edited }));
  const summarize = vi.fn().mockRejectedValueOnce(new Error('offline failure')).mockResolvedValue([{ op: 'add', text: 'new fact', keywords: ['new'], sourceMessageIds: ['om_1'] }]);
  const execute = topicSummaryExecutor({ store, now: () => now, check, model: { summarize }, source: () => async () => ({ messages: [edited], hasMore: false, verifiedThread: true }) });
  const runtime = new TopicScheduler(store, () => ({ ...config, slot: 'one', snapshot: JSON.stringify(config) }), execute); runtimes.push(runtime);
  runtime.tick(); await runtime.idle();
  expect(store.read(key)!.summaries).toEqual([]); expect(store.read(key)!.summarizedThroughCursor).toBe(cursor);
  now += config.retryBaseMs; runtime.tick(); await runtime.idle();
  // The expired deployment lease is reacquired on this tick; recovered work starts next tick.
  runtime.tick(); await runtime.idle();
  expect(store.read(key)!.summaries.map(summary => summary.text)).toEqual(['new fact']);
  expect(store.read(key)!.summarizedThroughCursor).toBe(cursor);
  expect(check).toHaveBeenCalledTimes(1);
});

it('bounds recent reference checks within one topic and defers transient failures rather than falsely deleting', async () => {
  const date = new Date(now - 3_600_000).toISOString(), key = seed(1, date);
  const sources = Array.from({ length: 15 }, (_, i) => ({ id: `om_ref${i}`, text: 'recent fact', createdAt: date }));
  store.commit({ topicKey: key, expectedRevision: store.read(key)!.revision, operationId: 'many', now: date, generatorKey: 'fake', verifiedMessageIds: sources.map(source => source.id), processedSources: sources, cursor: encodeCursor({ time: date, ids: ['om_1', ...sources.map(source => source.id)] }), mutations: [{ op: 'add', text: 'many recent sources', keywords: [], sourceMessageIds: sources.map(source => source.id) }] });
  const check = vi.fn().mockRejectedValue(new Error('permission_or_timeout'));
  let slot = 'one';
  const execute = topicSummaryExecutor({ store, now: () => now, check, model: { summarize: vi.fn() }, source: () => async () => ({ messages: [], hasMore: false, verifiedThread: true }) });
  const runtime = new TopicScheduler(store, () => ({ ...config, slot, snapshot: JSON.stringify(config) }), execute); runtimes.push(runtime);
  runtime.tick(); await runtime.idle();
  expect(check).toHaveBeenCalledTimes(10);
  expect(store.read(key)!.summaries).toHaveLength(2);
  slot = 'two'; runtime.tick(); await runtime.idle();
  // New, previously unchecked references are fair game; the ten failures are backoff-limited.
  expect(check).toHaveBeenCalledTimes(16);
  slot = 'three'; runtime.tick(); await runtime.idle();
  expect(check).toHaveBeenCalledTimes(16);
});
it('rechecks current scope between review calls and before starting normal source pagination', async () => {
  const key = seed(1), read = vi.fn(), summarize = vi.fn();
  const check = vi.fn(async (): Promise<TopicSourceCheck> => { config.allowedChatIds = []; return { state: 'unknown' }; });
  const execute = topicSummaryExecutor({ store, now: () => now, check, model: { summarize }, source: () => read });
  const runtime = new TopicScheduler(store, () => ({ ...config, slot: 'one', snapshot: JSON.stringify(config) }), execute); runtimes.push(runtime);
  runtime.tick(); await runtime.idle();
  expect(check).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
  expect(store.read(key)!.summaries).toHaveLength(1); expect(store.jobs.list()[0].state).toBe('skipped');
});
