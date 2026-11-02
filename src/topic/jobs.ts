import type { DatabaseSyncLike } from '../services/sqlite-compat.js';

export interface TopicLease { owner: string; epoch: number }
export interface TopicJob {
  id: number;
  batch: string;
  topicKey: string;
  snapshot: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  attempt: number;
  step: number;
  failures: number;
  acceptedAt: number;
  availableAt: number;
  error: string | null;
}
export interface TopicClaim { lease: TopicLease; job: TopicJob }

export const TOPIC_JOB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS topic_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS topic_batches (slot TEXT PRIMARY KEY, accepted INTEGER NOT NULL, completed INTEGER, snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS topic_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, topicKey TEXT NOT NULL,
    snapshot TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
    step INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    availableAt INTEGER NOT NULL, error TEXT, UNIQUE(batch, topicKey)
  );
  CREATE INDEX IF NOT EXISTS topic_jobs_ready ON topic_jobs(state, availableAt, id);
`;

/** Topic-only coordination. Session lease APIs cannot atomically commit our content and job receipt. */
export class TopicJobQueue {
  constructor(
    private readonly db: DatabaseSyncLike,
    private readonly transaction: <T>(action: () => T) => T,
    private readonly clock: () => number,
  ) {}

  acquire(owner: string, durationMs: number): TopicLease | null {
    if (!owner || !Number.isSafeInteger(durationMs) || durationMs < 1) throw new Error('invalid_topic_lease');
    return this.transaction(() => {
      const now = this.clock();
      const old = this.db.prepare('SELECT * FROM topic_lease WHERE singleton=1').get() as (TopicLease & { expires: number }) | undefined;
      if (old && old.expires > now && old.owner !== owner) return null;
      const takeover = !old || old.expires <= now;
      const epoch = takeover ? (old?.epoch ?? 0) + 1 : old.epoch;
      this.db.prepare('INSERT INTO topic_lease VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, epoch=excluded.epoch, expires=excluded.expires')
        .run(owner, epoch, now + durationMs);
      // Only an expired lease can recover running work. Every old completion is fenced by epoch.
      if (takeover) this.db.prepare("UPDATE topic_jobs SET state='queued', availableAt=? WHERE state='running'").run(now);
      return { owner, epoch };
    });
  }

  valid(lease: TopicLease): boolean {
    return !!this.db.prepare('SELECT 1 FROM topic_lease WHERE singleton=1 AND owner=? AND epoch=? AND expires>?')
      .get(lease.owner, lease.epoch, this.clock());
  }

  release(lease: TopicLease): void {
    this.db.prepare('UPDATE topic_lease SET expires=0 WHERE singleton=1 AND owner=? AND epoch=?').run(lease.owner, lease.epoch);
  }

  /** Disabled means no new admission. Existing queued jobs are deliberately not cancelled. */
  admit(lease: TopicLease, input: { enabled: boolean; slot: string; topicKeys: readonly string[]; snapshot: string; limit: number }): boolean {
    return this.transaction(() => {
      if (!input.enabled || !this.valid(lease)) return false;
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !input.slot || !input.snapshot) throw new Error('invalid_topic_batch');
      if (this.db.prepare('SELECT 1 FROM topic_batches WHERE slot=?').get(input.slot)) return false;
      // Coalesce missed schedule slots; never grow another backlog behind an unfinished batch.
      if (this.db.prepare('SELECT 1 FROM topic_batches WHERE completed IS NULL').get()) return false;
      const now = this.clock();
      this.db.prepare('INSERT INTO topic_batches VALUES (?, ?, NULL, ?)').run(input.slot, now, input.snapshot);
      const last = new Map((this.db.prepare('SELECT topicKey, MAX(id) AS last FROM topic_jobs GROUP BY topicKey').all() as Array<{ topicKey: string; last: number }>).map(row => [row.topicKey, row.last]));
      const keys = [...new Set(input.topicKeys)].sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0) || a.localeCompare(b)).slice(0, input.limit);
      for (const key of keys) this.db.prepare("INSERT INTO topic_jobs (batch, topicKey, snapshot, state, availableAt) VALUES (?, ?, ?, 'queued', ?)")
        .run(input.slot, key, input.snapshot, now);
      this.completeBatch(input.slot);
      return true;
    });
  }

  claim(lease: TopicLease, concurrency: number): TopicClaim | null {
    return this.transaction(() => {
      if (!this.valid(lease)) return null;
      if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('invalid_topic_concurrency');
      const active = this.db.prepare("SELECT COUNT(*) AS n FROM topic_jobs WHERE state='running'").get() as { n: number };
      if (active.n >= concurrency) return null;
      const job = this.db.prepare("SELECT j.*, b.accepted AS acceptedAt FROM topic_jobs j JOIN topic_batches b ON b.slot=j.batch WHERE j.state='queued' AND j.availableAt<=? ORDER BY j.availableAt, j.id LIMIT 1").get(this.clock()) as TopicJob | undefined;
      if (!job) return null;
      this.db.prepare("UPDATE topic_jobs SET state='running', attempt=attempt+1 WHERE id=?").run(job.id);
      return { lease: { ...lease }, job: { ...job, state: 'running', attempt: job.attempt + 1 } };
    });
  }

  /** Called inside the content transaction; validates the attempt as well as the owner epoch. */
  assertClaim(claim: TopicClaim): void {
    if (!this.valid(claim.lease) || !this.db.prepare("SELECT 1 FROM topic_jobs WHERE id=? AND topicKey=? AND state='running' AND attempt=?")
      .get(claim.job.id, claim.job.topicKey, claim.job.attempt)) throw new Error('stale_topic_claim');
  }

  private completeBatch(batch: string): void {
    this.db.prepare("UPDATE topic_batches SET completed=? WHERE slot=? AND completed IS NULL AND NOT EXISTS (SELECT 1 FROM topic_jobs WHERE batch=? AND state IN ('queued', 'running'))")
      .run(this.clock(), batch, batch);
  }

  /** Caller must hold the same transaction as its content write. */
  finishInsideTransaction(claim: TopicClaim, state: 'done' | 'skipped'): void {
    this.assertClaim(claim);
    this.db.prepare('UPDATE topic_jobs SET state=?, error=NULL WHERE id=?').run(state, claim.job.id);
    this.completeBatch(claim.job.batch);
  }

  continueInsideTransaction(claim: TopicClaim, maxSteps: number): void {
    this.assertClaim(claim);
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error('invalid_topic_step_budget');
    if (claim.job.step + 1 >= maxSteps) { this.finishInsideTransaction(claim, 'done'); return; }
    this.db.prepare("UPDATE topic_jobs SET state='queued', step=step+1, failures=0, availableAt=?, error=NULL WHERE id=?").run(this.clock(), claim.job.id);
  }

  fail(claim: TopicClaim, code: string, retry: { maxAttempts: number; delayMs: number }): void {
    if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1 || !Number.isSafeInteger(retry.delayMs) || retry.delayMs < 1) throw new Error('invalid_topic_retry');
    this.transaction(() => {
      this.assertClaim(claim);
      // Persist only a constrained code, never provider output, credentials or source text.
      const error = /^[a-z_]{1,64}$/.test(code) ? code : 'topic_job_failed';
      this.db.prepare('UPDATE topic_jobs SET state=?, failures=failures+1, availableAt=?, error=? WHERE id=?')
        .run(claim.job.failures + 1 >= retry.maxAttempts ? 'failed' : 'queued', this.clock() + retry.delayMs, error, claim.job.id);
      this.completeBatch(claim.job.batch);
    });
  }

  list(): TopicJob[] { return this.db.prepare('SELECT j.*, b.accepted AS acceptedAt FROM topic_jobs j JOIN topic_batches b ON b.slot=j.batch ORDER BY j.id').all() as TopicJob[]; }
  batches(): Array<{ slot: string; accepted: number; completed: number | null }> {
    return this.db.prepare('SELECT slot, accepted, completed FROM topic_batches ORDER BY accepted, slot').all() as Array<{ slot: string; accepted: number; completed: number | null }>;
  }
}
