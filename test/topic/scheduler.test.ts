import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicStore, type TopicCommit } from '../../src/topic/store.js';
import { TopicScheduler, type TopicRunPolicy, type TopicExecutor } from '../../src/topic/scheduler.js';
import { encodeCursor } from '../../src/topic/source.js';
import type { TopicClaim } from '../../src/topic/jobs.js';

let directory: string, store: TopicStore, policy: TopicRunPolicy;
let schedulers: TopicScheduler[];
const keys = ['thread:oc_a:om_a', 'thread:oc_a:om_b'];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  directory = mkdtempSync(join(tmpdir(), 'topic-scheduler-'));
  store = new TopicStore(join(directory, 'topics.db'), () => Date.now());
  for (const root of ['om_a', 'om_b']) store.discover({ chatId: 'oc_a', rootMessageId: root, title: root, accessPolicyRef: 'dashboard' }, new Date().toISOString());
  policy = { enabled: true, allowedChatIds: ['oc_a'], maxConcurrentTopics: 1, maxTopicsPerRun: 2, jobTimeoutMs: 500, maxAttempts: 2, retryBaseMs: 10, slot: '1', snapshot: '{}' };
  schedulers = [];
});
afterEach(async () => {
  for (const scheduler of schedulers) await scheduler.close();
  store.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers();
});
function scheduler(execute: TopicExecutor, leaseMs = 1000) {
  const item = new TopicScheduler(store, () => policy, execute, leaseMs);
  schedulers.push(item); return item;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function input(claim: TopicClaim): TopicCommit {
  return { topicKey: claim.job.topicKey, expectedRevision: store.read(claim.job.topicKey)!.revision,
    operationId: `job-${claim.job.id}`, mutations: [{ op: 'noop' }], verifiedMessageIds: ['message'],
    cursor: encodeCursor({ time: new Date().toISOString(), ids: ['message'] }), generatorKey: 'fake', now: new Date().toISOString() };
}
it('disabling while the first provider waits preserves both its late result and admitted queued work', async () => {
  const waiting = deferred<TopicCommit>();
  let first!: TopicClaim;
  const execute = vi.fn<TopicExecutor>().mockImplementationOnce(claim => { first = claim; return waiting.promise; }).mockImplementation(async claim => input(claim));
  const runtime = scheduler(execute);
  runtime.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  policy = { ...policy, enabled: false, slot: '2' };
  runtime.tick();
  waiting.resolve(input(first)); await runtime.idle();
  expect(store.read(keys[0])!.summarizedThroughCursor).toBeDefined();
  runtime.tick(); await runtime.idle();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(store.read(keys[1])!.summarizedThroughCursor).toBeDefined();
  expect(store.jobs.batches()).toHaveLength(1);
  policy = { ...policy, enabled: true, slot: '3' };
  runtime.tick(); await runtime.idle();
  expect(execute).toHaveBeenCalledTimes(3);
});
it('removing update scope prevents new queued reads without deleting existing content', async () => {
  const waiting = deferred<TopicCommit>(); let first!: TopicClaim;
  const execute = vi.fn<TopicExecutor>().mockImplementation(claim => { first = claim; return waiting.promise; });
  const runtime = scheduler(execute); runtime.tick();
  policy.allowedChatIds = [];
  waiting.resolve(input(first)); await runtime.idle();
  runtime.tick(); await runtime.idle();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(store.jobs.list().map(job => job.state)).toEqual(['done', 'skipped']);
  expect(store.read(keys[0])!.summarizedThroughCursor).toBeDefined();
});
it('revocation between external requests prevents the second request even within an admitted job', async () => {
  const read = deferred<void>(); const model = vi.fn();
  const runtime = scheduler(async (_, context) => {
    await read.promise; context.assertAuthorized(); model(); return null;
  });
  runtime.tick(); policy.allowedChatIds = []; read.resolve(); await runtime.idle();
  expect(model).not.toHaveBeenCalled();
  expect(store.jobs.list()[0].state).toBe('skipped');
});
it('times out an ignoring provider, drains another topic, and never commits the late result', async () => {
  const hung = deferred<TopicCommit>(); let first!: TopicClaim;
  const execute = vi.fn<TopicExecutor>().mockImplementationOnce(claim => { first = claim; return hung.promise; }).mockImplementation(async claim => input(claim));
  const runtime = scheduler(execute); runtime.tick();
  await vi.advanceTimersByTimeAsync(501); await runtime.idle();
  expect(store.jobs.list()[0]).toMatchObject({ state: 'queued', error: 'topic_job_timeout' });
  runtime.tick(); await runtime.idle();
  expect(store.read(keys[1])!.summarizedThroughCursor).toBeDefined();
  hung.resolve(input(first)); await Promise.resolve();
  expect(store.read(keys[0])!.summarizedThroughCursor).toBeUndefined();
});
it('overlapping ticks renew one lease without duplicating a running model call', async () => {
  const waiting = deferred<TopicCommit>(); let first!: TopicClaim;
  const execute = vi.fn<TopicExecutor>().mockImplementation(claim => { first = claim; return waiting.promise; });
  const runtime = scheduler(execute, 100);
  runtime.tick();
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(60); runtime.tick(); }
  expect(execute).toHaveBeenCalledTimes(1);
  waiting.resolve(input(first)); await runtime.idle();
  expect(store.jobs.list()[0].state).toBe('done');
});
it('a replacement owner wins after a missed heartbeat and the old completion is rejected', async () => {
  const waiting = deferred<TopicCommit>(); let first!: TopicClaim;
  const old = scheduler(claim => { first = claim; return waiting.promise; }, 100);
  old.tick(); await vi.advanceTimersByTimeAsync(101);
  const replacement = scheduler(async claim => input(claim), 100);
  replacement.tick(); await replacement.idle(); replacement.tick(); await replacement.idle();
  const successful = store.read(keys[0])!.summarizedThroughCursor;
  expect(successful).toBeDefined();
  waiting.resolve(input(first)); await old.idle();
  expect(store.read(keys[0])!.summarizedThroughCursor).toBe(successful);
  expect(store.jobs.list()[0]).toMatchObject({ state: 'done', attempt: 2 });
});
it('shutdown aborts without dropping durable accepted work, then disabled restart drains it', async () => {
  const old = scheduler(async () => new Promise(() => {})); old.tick();
  await old.close();
  expect(store.jobs.list()[0].state).toBe('running');
  policy.enabled = false;
  const restored = scheduler(async claim => input(claim));
  restored.tick(); await restored.idle(); restored.tick(); await restored.idle();
  expect(store.jobs.list().map(job => job.state)).toEqual(['done', 'done']);
});
it('an expired same-owner lease never lets an old finalizer delete a recovered running task', async () => {
  policy.maxConcurrentTopics = 2;
  const execute = vi.fn<TopicExecutor>().mockImplementation(async () => new Promise(() => {}));
  const runtime = scheduler(execute, 100); runtime.tick();
  expect(execute).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(101); runtime.tick(); await runtime.idle();
  runtime.tick();
  expect(execute).toHaveBeenCalledTimes(4);
  runtime.tick();
  expect(execute).toHaveBeenCalledTimes(4);
  expect(store.jobs.list().map(job => job.state)).toEqual(['running', 'running']);
});
