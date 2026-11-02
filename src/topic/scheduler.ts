import { randomUUID } from 'node:crypto';
import type { TopicStore, TopicCommit } from './store.js';
import type { TopicClaim, TopicLease } from './jobs.js';

export interface TopicRunPolicy {
  enabled: boolean;
  allowedChatIds: readonly string[];
  maxConcurrentTopics: number;
  maxTopicsPerRun: number;
  jobTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  /** Current due slot, or null when not due. Missed slots are coalesced by the host. */
  slot: string | null;
  /** Validated, non-secret configuration; each accepted batch retains its budgets/model references. */
  snapshot: string;
}
export interface TopicExecutionContext {
  signal: AbortSignal;
  /** Recheck before each new source/model request; removing a chat revokes new external reads. */
  assertAuthorized(): void;
}
export type TopicExecutor = (claim: TopicClaim, context: TopicExecutionContext) => Promise<TopicCommit | null>;

/** A deployment owner, independent of Session/CLI/PTY lifecycle. The host drives tick and close. */
export class TopicScheduler {
  private readonly owner = randomUUID();
  private lease: TopicLease | null = null;
  private readonly running = new Map<number, { abort: AbortController; promise: Promise<void> }>();
  private stopped = false;
  lastError: string | null = null;

  constructor(
    private readonly store: TopicStore,
    private readonly policy: () => TopicRunPolicy,
    private readonly execute: TopicExecutor,
    private readonly leaseMs = 30_000,
  ) {}

  tick(): void {
    if (this.stopped) return;
    const lease = this.store.jobs.acquire(this.owner, this.leaseMs);
    if (!lease) return;
    if (this.lease && this.lease.epoch !== lease.epoch) {
      for (const task of this.running.values()) task.abort.abort(new Error('stale_topic_claim'));
      this.lease = lease;
      // Let old promise finalizers remove their entries before reusing recovered job ids.
      return;
    }
    this.lease = lease;
    const policy = this.policy();
    if (policy.slot) this.store.jobs.admit(lease, {
      enabled: policy.enabled, slot: policy.slot, snapshot: policy.snapshot, limit: policy.maxTopicsPerRun,
      topicKeys: this.store.list().filter(topic => policy.allowedChatIds.includes(topic.chatId)).map(topic => topic.topicKey),
    });
    // Disabled still drains admitted work. Decreasing concurrency stops new starts until below the cap.
    while (this.running.size < policy.maxConcurrentTopics) {
      const claim = this.store.jobs.claim(lease, policy.maxConcurrentTopics);
      if (!claim) break;
      const abort = new AbortController();
      const promise = this.run(claim, abort, policy)
        .catch(() => { this.lastError = 'topic_scheduler_failed'; })
        .finally(() => { this.running.delete(claim.job.id); });
      this.running.set(claim.job.id, { abort, promise });
    }
  }

  private async run(claim: TopicClaim, abort: AbortController, policy: TopicRunPolicy): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const assertAuthorized = (): void => {
      abort.signal.throwIfAborted();
      this.store.jobs.assertClaim(claim);
      const topic = this.store.read(claim.job.topicKey);
      if (!topic || !this.policy().allowedChatIds.includes(topic.chatId)) throw new Error('topic_scope_removed');
    };
    try {
      assertAuthorized();
      const deadline = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
        timer = setTimeout(() => abort.abort(new Error('topic_job_timeout')), policy.jobTimeoutMs);
      });
      const input = await Promise.race([this.execute(claim, { signal: abort.signal, assertAuthorized }), deadline]);
      // Disable is not cancellation. A removed scope may finish an already-issued call, but no new one.
      abort.signal.throwIfAborted();
      if (this.store.settle(claim, input) === 'conflict') throw new Error('topic_revision_conflict');
    } catch (error) {
      if (this.stopped || !this.store.jobs.valid(claim.lease)) return;
      try {
        if (error instanceof Error && error.message === 'topic_scope_removed') this.store.settle(claim, null, true);
        else this.store.jobs.fail(claim, error instanceof Error ? error.message : 'topic_job_failed', {
          maxAttempts: policy.maxAttempts,
          delayMs: Math.min(policy.retryBaseMs * 2 ** Math.min(claim.job.attempt - 1, 20), 3_600_000),
        });
      } catch (failure) {
        if (!(failure instanceof Error) || failure.message !== 'stale_topic_claim') throw failure;
      }
    } finally { if (timer) clearTimeout(timer); }
  }

  async idle(): Promise<void> { await Promise.all([...this.running.values()].map(task => task.promise)); }

  async close(): Promise<void> {
    this.stopped = true;
    for (const task of this.running.values()) task.abort.abort(new Error('topic_runtime_stopped'));
    await this.idle();
    if (this.lease) this.store.jobs.release(this.lease);
    this.lease = null;
  }
}
