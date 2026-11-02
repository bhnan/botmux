import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TopicStore, type TopicCommit } from '../../src/topic/store.js';
import { encodeCursor } from '../../src/topic/source.js';
import type { TopicClaim } from '../../src/topic/jobs.js';

let directory: string, store: TopicStore, time: number;
const key = 'thread:oc_a:om_a';
beforeEach(() => {
  time = 1000;
  directory = mkdtempSync(join(tmpdir(), 'topic-jobs-'));
  store = new TopicStore(join(directory, 'topics.db'), () => time);
  store.discover({ chatId: 'oc_a', rootMessageId: 'om_a', title: 'a', accessPolicyRef: 'dashboard' }, new Date(time).toISOString());
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
function admit(slot = '1', keys = [key], limit = keys.length) {
  const lease = store.jobs.acquire('owner', 100)!;
  store.jobs.admit(lease, { enabled: true, slot, topicKeys: keys, snapshot: '{}', limit });
  return lease;
}
function input(claim: TopicClaim): TopicCommit {
  return {
    topicKey: key, expectedRevision: store.read(key)!.revision, operationId: `job-${claim.job.id}`,
    mutations: [{ op: 'add', text: 'summary', keywords: ['key'], sourceMessageIds: ['message'] }],
    verifiedMessageIds: ['message'], cursor: encodeCursor({ time: new Date(time).toISOString(), ids: ['message'] }),
    generatorKey: 'fake', now: new Date(time).toISOString(),
  };
}
it('only one deployment owns the lease and the same slot cannot be admitted twice', () => {
  const lease = admit();
  const other = new TopicStore(store.path, () => time);
  try {
    expect(other.jobs.acquire('competitor', 100)).toBeNull();
    expect(other.jobs.admit({ owner: 'competitor', epoch: lease.epoch }, { enabled: true, slot: '2', topicKeys: [key], snapshot: '{}', limit: 1 })).toBe(false);
    expect(store.jobs.admit(lease, { enabled: true, slot: '1', topicKeys: [key], snapshot: '{}', limit: 1 })).toBe(false);
    expect(store.jobs.list()).toHaveLength(1);
  } finally { other.close(); }
});
it('takes over expired running jobs after reopen and fences late owners, even with an unchanged revision', () => {
  const stale = store.jobs.claim(admit(), 1)!;
  const late = input(stale);
  time += 100;
  store.close(); store = new TopicStore(join(directory, 'topics.db'), () => time);
  const lease = store.jobs.acquire('replacement', 100)!;
  const fresh = store.jobs.claim(lease, 1)!;
  expect(fresh.job.id).toBe(stale.job.id);
  expect(fresh.job.attempt).toBe(stale.job.attempt + 1);
  expect(() => store.settle(stale, late)).toThrow('stale_topic_claim');
  expect(store.read(key)!.summaries).toHaveLength(0);
  expect(store.settle(fresh, late)).toBe('committed');
  expect(store.jobs.list()[0].state).toBe('done');
  expect(store.jobs.batches()[0].completed).toBe(time);
});
it('rolls back content, receipt, cursor and completion together when a second mutation fails', () => {
  const claim = store.jobs.claim(admit(), 1)!;
  const batch = input(claim);
  batch.mutations.push({ op: 'update', id: 'not-a-summary', text: 'invalid', keywords: [], sourceMessageIds: ['message'] });
  expect(() => store.settle(claim, batch)).toThrow('invalid_summary_update');
  expect(store.read(key)!.summaries).toEqual([]);
  expect(store.read(key)!.summarizedThroughCursor).toBeUndefined();
  expect(store.jobs.list()[0].state).toBe('running');
  expect(store.jobs.batches()[0].completed).toBeNull();
  batch.mutations.pop();
  expect(store.settle(claim, batch)).toBe('committed');
  expect(() => store.settle(claim, batch)).toThrow('stale_topic_claim');
});
it('disabled admission still permits every previously admitted queued job to complete', () => {
  const lease = admit('1', [key, 'thread:oc_a:om_b']);
  const first = store.jobs.claim(lease, 1)!;
  expect(store.jobs.claim(lease, 1)).toBeNull();
  expect(store.jobs.admit(lease, { enabled: false, slot: '2', topicKeys: [key], snapshot: '{}', limit: 1 })).toBe(false);
  store.settle(first, input(first));
  const queued = store.jobs.claim(lease, 1)!;
  expect(queued.job.topicKey).toBe('thread:oc_a:om_b');
  store.settle(queued, null);
  expect(store.jobs.list().map(job => job.state)).toEqual(['done', 'done']);
  expect(store.jobs.batches()).toHaveLength(1);
});
it('bounded backoff does not block other topics and a stale attempt cannot settle a retry', () => {
  const lease = admit('1', [key, 'thread:oc_a:om_b']);
  const first = store.jobs.claim(lease, 1)!;
  store.jobs.fail(first, 'a secret or model response', { maxAttempts: 2, delayMs: 20 });
  const other = store.jobs.claim(lease, 1)!;
  expect(other.job.topicKey).not.toBe(first.job.topicKey);
  store.settle(other, null);
  expect(store.jobs.claim(lease, 1)).toBeNull();
  time += 20;
  const retry = store.jobs.claim(lease, 1)!;
  expect(() => store.settle(first, input(first))).toThrow('stale_topic_claim');
  store.jobs.fail(retry, 'topic_model_failed', { maxAttempts: 2, delayMs: 20 });
  expect(store.jobs.list()[0]).toMatchObject({ state: 'failed', error: 'topic_model_failed' });
  expect(store.read(key)!.summarizedThroughCursor).toBeUndefined();
  expect(store.jobs.batches()[0].completed).toBe(time);
});
it('fair bounded runs eventually visit every topic, including previously failing ones', () => {
  const keys = [key, 'b', 'c', 'd'];
  for (let i = 0; i < 4; i++) {
    const lease = admit(String(i), keys, 1);
    const claim = store.jobs.claim(lease, 1)!;
    if (i === 0) store.jobs.fail(claim, 'topic_read_failed', { maxAttempts: 1, delayMs: 1 });
    else store.settle(claim, null);
  }
  expect(new Set(store.jobs.list().map(job => job.topicKey))).toEqual(new Set(keys));
});
it('coalesces schedule ticks while a long batch is still queued or running', () => {
  const lease = admit('1');
  for (let i = 2; i < 100; i++) expect(store.jobs.admit(lease, { enabled: true, slot: String(i), topicKeys: [key], snapshot: '{}', limit: 1 })).toBe(false);
  store.settle(store.jobs.claim(lease, 1)!, null);
  expect(store.jobs.admit(lease, { enabled: true, slot: '100', topicKeys: [key], snapshot: '{}', limit: 1 })).toBe(true);
  expect(store.jobs.batches()).toHaveLength(2);
});
it('rejects an expired claim before any replacement has changed its attempt or topic revision', () => {
  const claim = store.jobs.claim(admit(), 1)!;
  const result = input(claim);
  time += 100;
  expect(() => store.settle(claim, result)).toThrow('stale_topic_claim');
  expect(() => store.observe(key, { latestAt: new Date(time).toISOString(), checkedAt: new Date(time).toISOString() }, claim)).toThrow('stale_topic_claim');
  expect(store.read(key)!.summarizedThroughCursor).toBeUndefined();
  expect(store.read(key)!.latestMessageAt).toBeUndefined();
  expect(store.jobs.list()[0].state).toBe('running');
});
it('a completed continuation attempt cannot overwrite the next step even under the same lease', () => {
  const lease = admit(); const first = store.jobs.claim(lease, 1)!;
  store.settle(first, { ...input(first), continuation: { maxSteps: 3 } });
  const next = store.jobs.claim(lease, 1)!;
  expect(next.job.step).toBe(1); expect(next.job.attempt).toBeGreaterThan(first.job.attempt);
  expect(() => store.settle(first, input(first))).toThrow('stale_topic_claim');
  expect(store.jobs.batches()[0].completed).toBeNull();
  store.settle(next, null); expect(store.jobs.batches()[0].completed).toBe(time);
});
