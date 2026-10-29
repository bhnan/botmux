/** Persisted topic knowledge store (spec 20261028-topic-search §3.1/§5).
 *
 * Storage substrate for the topic catalog: whole-row JSON topic rows (the TS
 * `Topic` type is the schema authority, mirroring session-store), a separate
 * embedding table so keyword scans never drag vectors, job records with
 * idempotency keys + leases, and a small schedule-state table (deployment
 * lease slot, fair-scan cursor).
 *
 * Cross-cutting invariants enforced HERE (defense in depth below the
 * model-output validator):
 * - Summary commits are revision-CAS and atomic: summaries, keywords, source
 *   refs, the success cursor and enqueued embedding jobs commit or roll back
 *   together. A failed commit leaves the cursor and revision untouched.
 * - `recordHistoryCheck` only advances lastCheckedAt — it can never move the
 *   summary cursor (spec §5.1: lastCheckedAt is not the processing
 *   authority).
 * - A changed summary invalidates its old embedding in the same transaction;
 *   a late `saveEmbedding` is dropped unless its contentHash still matches
 *   the current summary text (spec §5.4).
 * - This module is the ONLY topic module allowed to depend on
 *   services/sqlite-compat.ts (spec §2).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSync, type DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { Topic, TopicSummary } from '../types.js';

export const TOPIC_STORE_SCHEMA_VERSION = 1;

/** Defense-in-depth cap on model-produced summary text (spec §5.3 长度上限). */
export const MAX_SUMMARY_TEXT_LENGTH = 20_000;
export const MAX_SUMMARY_KEYWORDS = 64;
export const MAX_SUMMARY_SOURCE_REFS = 200;

export function computeSummaryContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Mutations accepted by `commitSummaryUpdate` — the validated output of the
 * model client (spec §5.3). The store re-validates so a buggy validator can
 * still not persist unknown ids, empty text or fabricated shapes. */
export type SummaryMutation =
  | { op: 'add'; text: string; keywords: string[]; sourceMessageIds: string[] }
  | { op: 'update'; id: string; text: string; keywords: string[]; sourceMessageIds: string[] }
  | { op: 'noop' };

export interface EnsureTopicInput {
  topicKey: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  accessPolicyRef: string;
  nativeThreadId?: string;
  sourceLarkAppId?: string;
}

export interface CommitSummaryUpdateInput {
  topicKey: string;
  expectedRevision: number;
  mutations: SummaryMutation[];
  generatorKey: string;
  now: string;
  summarizedThroughCursor?: string;
  sourceThroughAt?: string;
  coverageStartAt?: string;
  /** When embedding is enabled: enqueue embedding jobs for changed summaries
   * in the SAME transaction as the commit (spec §5.2 step 8). */
  embeddingModelKey?: string;
}

export type TopicJobKind = 'summary' | 'embedding';
export type TopicJobState = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface TopicJobRecord {
  jobKey: string;
  kind: TopicJobKind;
  topicKey: string;
  payload: Record<string, unknown>;
  state: TopicJobState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  jobKey: string;
  kind: TopicJobKind;
  topicKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  now: string;
}

export interface ClaimJobsOptions {
  now: string;
  owner: string;
  leaseTtlMs: number;
  limit: number;
  kinds?: readonly TopicJobKind[];
}

/** Sanitized error code contract for job rows (spec §3.1: 脱敏错误码 — never
 * raw provider/exception text). */
export function sanitizeJobErrorCode(code: unknown): string {
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';
}

/** Exponential backoff with a cap: base * 2^attempt, capped (spec §5.4). */
export function jobRetryDelayMs(attemptCount: number): number {
  const base = 60_000;
  const cap = 24 * 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attemptCount - 1), cap);
}

export class TopicRevisionConflictError extends Error {
  override readonly name = 'TopicRevisionConflictError';
  constructor(readonly topicKey: string, readonly currentRevision: number) {
    super(`topic_revision_conflict:${topicKey}:${currentRevision}`);
  }
}

export class TopicMutationValidationError extends Error {
  override readonly name = 'TopicMutationValidationError';
  constructor(readonly code: string) {
    super(`topic_mutation_invalid:${code}`);
  }
}

/** True when a node:sqlite error is the recoverable write-lock contention. */
function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes('database is locked') || message.includes('database table is locked')
    || message.includes('sqlite_busy') || message.includes('sqlite_locked');
}

/** Synchronous backoff (Atomics.wait yields instead of spinning). */
function sleepShort(attempt: number): void {
  const base = Math.min(20 * attempt, 120);
  const jitter = Number(process.hrtime.bigint() % 17n);
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, base + jitter); }
  catch { /* Atomics.wait unavailable; fall through */ }
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS topics (
  topic_key TEXT PRIMARY KEY,
  row TEXT NOT NULL,
  chat_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.chatId')) VIRTUAL,
  root_message_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.rootMessageId')) VIRTUAL,
  updated_at TEXT GENERATED ALWAYS AS (json_extract(row, '$.updatedAt')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS idx_topics_chat_root ON topics(chat_id, root_message_id);
CREATE INDEX IF NOT EXISTS idx_topics_updated_at ON topics(updated_at);
CREATE TABLE IF NOT EXISTS topic_embeddings (
  summary_id TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_embeddings_topic ON topic_embeddings(topic_key);
CREATE TABLE IF NOT EXISTS topic_jobs (
  job_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('summary','embedding')),
  topic_key TEXT NOT NULL,
  payload_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_jobs_due ON topic_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_topic_jobs_topic ON topic_jobs(topic_key, state);
CREATE TABLE IF NOT EXISTS topic_schedule_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface TopicRowDb { topic_key: string; row: string }

interface JobRowDb {
  job_key: string;
  kind: string;
  topic_key: string;
  payload_json: string | null;
  state: string;
  attempt_count: number | bigint;
  max_attempts: number | bigint;
  next_attempt_at: string | null;
  last_error_code: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentLeaseValue {
  owner: string;
  expiresAt: string;
}

export interface DeploymentLeaseResult {
  acquired: boolean;
  holder?: string;
  expiresAt?: string;
}

export class TopicStore {
  readonly path: string;
  private readonly db: DatabaseSyncLike;
  private readonly instanceId = randomUUID();
  private closed = false;

  private constructor(dataDir: string, db: DatabaseSyncLike) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'topic-search.sqlite');
    this.db = db;
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.enableWalWithRetry();
    const version = this.schemaVersion();
    if (version > TOPIC_STORE_SCHEMA_VERSION) {
      throw new Error(`topic_store_schema_newer:${version}`);
    }
    if (version < TOPIC_STORE_SCHEMA_VERSION) this.migrate();
  }

  static async open(dataDir: string): Promise<TopicStore> {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, 'topic-search.sqlite');
    const db = await openDatabaseSync(path);
    try {
      return new TopicStore(dataDir, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  get owner(): string { return this.instanceId; }

  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version?: unknown })?.user_version ?? 0);
  }

  private enableWalWithRetry(): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try {
        const mode = String((this.db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode?: unknown })?.journal_mode ?? '').toLowerCase();
        if (mode === 'wal') return;
        if (attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw new Error(`topic_store_wal_mode_not_set:${mode || 'unknown'}`);
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
  }

  /** Single-step migration (schema is at v1 today). Same guarded pattern as
   * skill-feedback-store: version re-read under the write lock so concurrent
   * openers never replay DDL. */
  private migrate(): void {
    this.withImmediateWrite(() => {
      const observed = this.schemaVersion();
      if (observed !== 0) return;
      this.db.exec(SCHEMA_V1);
      this.db.exec(`PRAGMA user_version=${TOPIC_STORE_SCHEMA_VERSION};`);
    });
  }

  private withImmediateWrite(fn: () => void): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
      try {
        fn();
        this.db.exec('COMMIT;');
        return;
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* connection may already be unwound */ }
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
  }

  // ─── Topic catalog ────────────────────────────────────────────────────────

  /** Insert-or-refresh a catalog entry from discovery. Does NOT bump revision
   * (discovery is not a summary mutation) and never drops existing summaries:
   * re-discovery after a session closes keeps the topic's knowledge (spec
   * §3.1: 删除 session 不自动删除话题). */
  ensureTopic(input: EnsureTopicInput, now: string): { created: boolean; topic: Topic } {
    if (!input.topicKey || !input.chatId || !input.rootMessageId) {
      throw new TopicMutationValidationError('topic_identity_missing');
    }
    let created = false;
    let loaded: Topic;
    this.withImmediateWrite(() => {
      const existing = this.readTopicRow(input.topicKey);
      if (!existing) {
        const topic: Topic = {
          schemaVersion: 1,
          topicKey: input.topicKey,
          chatId: input.chatId,
          rootMessageId: input.rootMessageId,
          ...(input.nativeThreadId ? { nativeThreadId: input.nativeThreadId } : {}),
          title: input.title,
          accessPolicyRef: input.accessPolicyRef,
          revision: 1,
          summaries: [],
          updatedAt: now,
        };
        this.writeTopicRow(topic);
        loaded = topic;
        created = true;
        return;
      }
      // Refresh directory snapshot fields only; keep knowledge + cursor + revision.
      existing.title = input.title || existing.title;
      existing.accessPolicyRef = input.accessPolicyRef || existing.accessPolicyRef;
      if (input.nativeThreadId) existing.nativeThreadId = input.nativeThreadId;
      if (input.sourceLarkAppId) existing.sourceLarkAppId = input.sourceLarkAppId;
      // chatId/rootMessageId are the identity; a mismatched call is a caller bug.
      if (existing.chatId !== input.chatId || existing.rootMessageId !== input.rootMessageId) {
        throw new TopicMutationValidationError('topic_identity_mismatch');
      }
      this.writeTopicRow(existing);
      loaded = existing;
    });
    return { created, topic: loaded! };
  }

  getTopic(topicKey: string): Topic | undefined {
    const row = this.selectTopicRow(topicKey);
    const topic = row ? this.parseTopicRow(row) : undefined;
    return topic ? this.hydrateTopic(topic) : undefined;
  }

  listTopics(): Topic[] {
    const rows = this.db.prepare('SELECT topic_key, row FROM topics ORDER BY topic_key').all() as TopicRowDb[];
    return rows
      .map(r => this.parseTopicRow(r))
      .filter((t): t is Topic => !!t)
      .map(t => this.hydrateTopic(t));
  }

  /** Cheap catalog fingerprint for pagination cursors: any committed change
   * to topics/summaries moves updatedAt (whole-row rewrite), so a cursor
   * minted before a change is rejected instead of silently paging over a
   * shifted ranking (spec §6.2: cursor 绑定查询/索引版本). COUNT pairs with
   * it so a same-ms rewrite across different row sets still differs. */
  catalogVersion(): string {
    const row = this.db.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS max_updated FROM topics').get() as { count: number; max_updated: string | null };
    return `${row.count}:${row.max_updated ?? ''}`;
  }

  private selectTopicRow(topicKey: string): TopicRowDb | undefined {
    return this.db.prepare('SELECT topic_key, row FROM topics WHERE topic_key=?').get(topicKey) as TopicRowDb | undefined;
  }

  private parseTopicRow(row: TopicRowDb): Topic | undefined {
    try {
      const parsed = JSON.parse(row.row) as Topic;
      return parsed.schemaVersion === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readTopicRow(topicKey: string): Topic | undefined {
    const row = this.selectTopicRow(topicKey);
    return row ? this.parseTopicRow(row) : undefined;
  }

  private writeTopicRow(topic: Topic): void {
    this.db.prepare('INSERT INTO topics(topic_key, row) VALUES(?, ?) ON CONFLICT(topic_key) DO UPDATE SET row=excluded.row')
      .run(topic.topicKey, JSON.stringify(topic));
  }

  /** Attach stored embeddings onto their summaries (load-time join). */
  private hydrateTopic(topic: Topic): Topic {
    if (!topic.summaries?.length) return topic;
    const embeddings = this.db
      .prepare('SELECT summary_id, model_key, content_hash, vector_json FROM topic_embeddings WHERE topic_key=?')
      .all(topic.topicKey) as Array<{ summary_id: string; model_key: string; content_hash: string; vector_json: string }>;
    const bySummary = new Map(embeddings.map(e => [e.summary_id, e]));
    topic.summaries = topic.summaries.map(summary => {
      const embedding = bySummary.get(summary.id);
      if (!embedding) return summary;
      if (computeSummaryContentHash(summary.text) !== embedding.content_hash) {
        // Stale vector for changed text: unusable by contract; drop rather
        // than serve a mismatched vector (spec §5.4).
        return summary;
      }
      return { ...summary, embedding: { modelKey: embedding.model_key, contentHash: embedding.content_hash, vector: JSON.parse(embedding.vector_json) as number[] } };
    });
    return topic;
  }

  // ─── Summary commit (revision CAS) ───────────────────────────────────────

  /** Atomically apply validated mutations and advance the success cursor.
   * Throws TopicRevisionConflictError on CAS mismatch (caller re-reads and
   * retries; it must NOT blind-overwrite). All-or-nothing: a validation
   * failure mid-batch persists nothing (cursor and revision untouched). */
  commitSummaryUpdate(input: CommitSummaryUpdateInput): Topic {
    let result: Topic | undefined;
    this.withImmediateWrite(() => {
      const topic = this.readTopicRow(input.topicKey);
      if (!topic) throw new TopicMutationValidationError('topic_not_found');
      if (topic.revision !== input.expectedRevision) {
        throw new TopicRevisionConflictError(input.topicKey, topic.revision);
      }
      const changedIds: string[] = [];
      const summaries = [...topic.summaries];
      const seenMutationIds = new Set<string>();
      for (const mutation of input.mutations) {
        if (!mutation || typeof mutation !== 'object') throw new TopicMutationValidationError('mutation_shape');
        if (mutation.op === 'noop') continue;
        const text = typeof mutation.text === 'string' ? mutation.text : '';
        if (!text.trim()) throw new TopicMutationValidationError('summary_text_empty');
        if (text.length > MAX_SUMMARY_TEXT_LENGTH) throw new TopicMutationValidationError('summary_text_too_long');
        if (!Array.isArray(mutation.keywords) || mutation.keywords.some(k => typeof k !== 'string' || !k.trim())) {
          throw new TopicMutationValidationError('summary_keywords_invalid');
        }
        if (mutation.keywords.length > MAX_SUMMARY_KEYWORDS) throw new TopicMutationValidationError('summary_keywords_too_many');
        if (!Array.isArray(mutation.sourceMessageIds) || mutation.sourceMessageIds.some(id => typeof id !== 'string' || !id)) {
          throw new TopicMutationValidationError('summary_sources_invalid');
        }
        if (mutation.sourceMessageIds.length > MAX_SUMMARY_SOURCE_REFS) throw new TopicMutationValidationError('summary_sources_too_many');
        if (mutation.op === 'add') {
          // Server-assigned id: the model never picks ids (spec §3.1).
          const summary: TopicSummary = {
            id: `ts_${randomUUID()}`,
            text,
            keywords: [...mutation.keywords],
            sourceMessageIds: [...mutation.sourceMessageIds],
            updatedAt: input.now,
            generatorKey: input.generatorKey,
          };
          summaries.push(summary);
          changedIds.push(summary.id);
          continue;
        }
        // update
        if (typeof mutation.id !== 'string' || !mutation.id) throw new TopicMutationValidationError('update_id_missing');
        if (seenMutationIds.has(mutation.id)) throw new TopicMutationValidationError('duplicate_mutation_for_summary');
        seenMutationIds.add(mutation.id);
        const index = summaries.findIndex(s => s.id === mutation.id);
        if (index < 0) throw new TopicMutationValidationError(`unknown_summary_id:${mutation.id}`);
        summaries[index] = {
          ...summaries[index],
          text,
          keywords: [...mutation.keywords],
          sourceMessageIds: [...mutation.sourceMessageIds],
          updatedAt: input.now,
          generatorKey: input.generatorKey,
        };
        changedIds.push(mutation.id);
      }
      topic.summaries = summaries;
      if (input.summarizedThroughCursor !== undefined) topic.summarizedThroughCursor = input.summarizedThroughCursor;
      if (input.sourceThroughAt !== undefined) topic.sourceThroughAt = input.sourceThroughAt;
      if (input.coverageStartAt !== undefined) topic.coverageStartAt = input.coverageStartAt;
      topic.revision += 1;
      topic.updatedAt = input.now;
      this.writeTopicRow(topic);
      // Content changed → old vectors are unusable immediately (spec §5.4).
      for (const id of changedIds) {
        this.db.prepare('DELETE FROM topic_embeddings WHERE summary_id=?').run(id);
      }
      // Embedding jobs for changed summaries commit in the SAME transaction.
      if (input.embeddingModelKey) {
        for (const id of changedIds) {
          const summary = summaries.find(s => s.id === id);
          if (!summary) continue;
          this.insertJobRow({
            jobKey: `embedding:${topic.topicKey}:${id}:${computeSummaryContentHash(summary.text)}`,
            kind: 'embedding',
            topicKey: topic.topicKey,
            payload: { summaryId: id, modelKey: input.embeddingModelKey, contentHash: computeSummaryContentHash(summary.text) },
            maxAttempts: 5,
            now: input.now,
          });
        }
      }
      result = topic;
    });
    return result!;
  }

  /** History-check bookkeeping. Only lastCheckedAt moves — never the summary
   * cursor, never summaries (spec §5.1). */
  recordHistoryCheck(topicKey: string, now: string): void {
    this.withImmediateWrite(() => {
      const topic = this.readTopicRow(topicKey);
      if (!topic) throw new TopicMutationValidationError('topic_not_found');
      topic.lastCheckedAt = now;
      this.writeTopicRow(topic);
    });
  }

  /** Remove summaries whose cited source messages disappeared from the
   * observable thread (deletion/revocation, spec §5.4). Same transaction drops
   * their embeddings and bumps revision; the cursor stays (the messages WERE
   * processed — removal is about knowledge, not progress). Returns the ids
   * actually removed (unknown ids are skipped). */
  invalidateSummaries(topicKey: string, summaryIds: readonly string[], now: string): string[] {
    const removed: string[] = [];
    this.withImmediateWrite(() => {
      const topic = this.readTopicRow(topicKey);
      if (!topic) throw new TopicMutationValidationError('topic_not_found');
      const doomed = new Set(summaryIds);
      const before = topic.summaries.length;
      topic.summaries = topic.summaries.filter(s => {
        if (doomed.has(s.id)) { removed.push(s.id); return false; }
        return true;
      });
      if (topic.summaries.length === before) return;
      topic.updatedAt = now;
      topic.revision += 1;
      this.writeTopicRow(topic);
      for (const id of removed) {
        this.db.prepare('DELETE FROM topic_embeddings WHERE summary_id=?').run(id);
      }
    });
    return removed;
  }

  /** Persist a computed vector. Late/mismatched results are dropped silently:
   * the summary text must still hash to contentHash (spec §5.4 迟到向量丢弃). */
  saveEmbedding(input: { topicKey: string; summaryId: string; modelKey: string; contentHash: string; vector: number[]; now: string }): { saved: boolean; reason?: 'summary_missing' | 'content_hash_mismatch' | 'topic_missing' } {
    let outcome: { saved: boolean; reason?: 'summary_missing' | 'content_hash_mismatch' | 'topic_missing' } = { saved: false };
    this.withImmediateWrite(() => {
      const topic = this.readTopicRow(input.topicKey);
      if (!topic) { outcome = { saved: false, reason: 'topic_missing' }; return; }
      const summary = topic.summaries.find(s => s.id === input.summaryId);
      if (!summary) { outcome = { saved: false, reason: 'summary_missing' }; return; }
      if (computeSummaryContentHash(summary.text) !== input.contentHash) {
        outcome = { saved: false, reason: 'content_hash_mismatch' };
        return;
      }
      this.db.prepare(`INSERT INTO topic_embeddings(summary_id, topic_key, model_key, content_hash, vector_json, updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(summary_id) DO UPDATE SET model_key=excluded.model_key, content_hash=excluded.content_hash,
          vector_json=excluded.vector_json, updated_at=excluded.updated_at`)
        .run(input.summaryId, input.topicKey, input.modelKey, input.contentHash, JSON.stringify(input.vector), input.now);
      outcome = { saved: true };
    });
    return outcome;
  }

  /** All stored vectors for a topic (vector recall path). Model/dimension
   * consistency is the caller's contract (spec §6.1). */
  listEmbeddings(topicKey: string): Array<{ summaryId: string; modelKey: string; contentHash: string; vector: number[] }> {
    const rows = this.db
      .prepare('SELECT summary_id, model_key, content_hash, vector_json FROM topic_embeddings WHERE topic_key=?')
      .all(topicKey) as Array<{ summary_id: string; model_key: string; content_hash: string; vector_json: string }>;
    return rows.map(r => ({ summaryId: r.summary_id, modelKey: r.model_key, contentHash: r.content_hash, vector: JSON.parse(r.vector_json) as number[] }));
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────

  /** Idempotent enqueue: an existing job_key is left untouched (retry state
   * and lease survive re-enqueues). */
  enqueueJob(input: EnqueueJobInput): { enqueued: boolean; job: TopicJobRecord } {
    let job: TopicJobRecord | undefined;
    let enqueued = false;
    this.withImmediateWrite(() => {
      const existing = this.readJobRow(input.jobKey);
      if (existing) { job = existing; return; }
      this.insertJobRow({ ...input, maxAttempts: input.maxAttempts ?? 5 });
      enqueued = true;
      job = this.readJobRow(input.jobKey)!;
    });
    return { enqueued, job: job! };
  }

  private insertJobRow(input: EnqueueJobInput): void {
    this.db.prepare(`INSERT OR IGNORE INTO topic_jobs(job_key, kind, topic_key, payload_json, state, attempt_count,
      max_attempts, next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES(?,?,?,?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)`)
      .run(input.jobKey, input.kind, input.topicKey, input.payload ? JSON.stringify(input.payload) : null,
        input.maxAttempts ?? 5, input.now, input.now);
  }

  private readJobRow(jobKey: string): TopicJobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM topic_jobs WHERE job_key=?').get(jobKey) as JobRowDb | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  private mapJob(row: JobRowDb): TopicJobRecord {
    return {
      jobKey: row.job_key,
      kind: row.kind as TopicJobKind,
      topicKey: row.topic_key,
      payload: row.payload_json ? JSON.parse(row.payload_json) as Record<string, unknown> : {},
      state: row.state as TopicJobState,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAt: row.next_attempt_at,
      lastErrorCode: row.last_error_code,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getJob(jobKey: string): TopicJobRecord | undefined {
    return this.readJobRow(jobKey);
  }

  /** Claim due jobs under a lease. Attempt count increments per claim, so a
   * crashed run (lease expiry → re-claim) still counts toward maxAttempts. */
  claimDueJobs(options: ClaimJobsOptions): TopicJobRecord[] {
    const claimed: TopicJobRecord[] = [];
    this.withImmediateWrite(() => {
      const kinds = options.kinds && options.kinds.length
        ? `AND kind IN (${options.kinds.map(() => '?').join(',')})`
        : '';
      // SQL-text order: two now params, then the kind placeholders, then LIMIT.
      const params: unknown[] = [options.now, options.now, ...(options.kinds ?? []), options.limit];
      const rows = this.db.prepare(`SELECT job_key FROM topic_jobs
        WHERE state IN ('pending','failed')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND (lease_expires_at IS NULL OR lease_expires_at < ?)
          ${kinds}
        ORDER BY created_at
        LIMIT ?`).all(...params) as Array<{ job_key: string }>;
      const leaseExpiresAt = new Date(Date.parse(options.now) + options.leaseTtlMs).toISOString();
      for (const row of rows) {
        this.db.prepare(`UPDATE topic_jobs SET state='running', attempt_count=attempt_count+1,
          lease_owner=?, lease_expires_at=?, updated_at=? WHERE job_key=?`)
          .run(options.owner, leaseExpiresAt, options.now, row.job_key);
        const job = this.readJobRow(row.job_key);
        if (job) claimed.push(job);
      }
    });
    return claimed;
  }

  /** Complete or fail a claimed job. Failure schedules a bounded exponential
   * backoff; exhausted attempts park the job as dead (visible, not silent). */
  finishJob(jobKey: string, outcome: { ok: true; now: string } | { ok: false; errorCode?: string; now: string }): TopicJobRecord {
    let job: TopicJobRecord | undefined;
    this.withImmediateWrite(() => {
      const row = this.readJobRow(jobKey);
      if (!row) throw new TopicMutationValidationError('job_not_found');
      if (outcome.ok) {
        this.db.prepare(`UPDATE topic_jobs SET state='done', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE job_key=?`)
          .run(outcome.now, jobKey);
      } else {
        const dead = row.attemptCount >= row.maxAttempts;
        const nextAttemptAt = dead ? row.nextAttemptAt
          : new Date(Date.parse(outcome.now) + jobRetryDelayMs(row.attemptCount)).toISOString();
        this.db.prepare(`UPDATE topic_jobs SET state=?, next_attempt_at=?, last_error_code=?, lease_owner=NULL,
          lease_expires_at=NULL, updated_at=? WHERE job_key=?`)
          .run(dead ? 'dead' : 'failed', nextAttemptAt, sanitizeJobErrorCode(outcome.errorCode), outcome.now, jobKey);
      }
      job = this.readJobRow(jobKey)!;
    });
    return job!;
  }

  /** Return crashed runs (lease expired while running) to the claimable pool
   * without wiping their failure history (spec §5.4 超时和重启后租约可回收). */
  expireLeases(now: string): number {
    let expired = 0;
    this.withImmediateWrite(() => {
      const result = this.db.prepare(`UPDATE topic_jobs SET state='pending', lease_owner=NULL, lease_expires_at=NULL,
        updated_at=? WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
        .run(now, now);
      expired = Number(result.changes);
    });
    return expired;
  }

  /** Release a claimed job back to the claimable pool WITHOUT burning an
   * attempt or touching its backoff — for aborts that are not the job's
   * fault (e.g. the feature was disabled mid-tick). Undoes the claim's
   * attempt increment so a disabled abort cannot accelerate the job toward
   * dead, and clears the lease so it is not stuck 'running' until expiry. */
  releaseJobToPending(jobKey: string, now: string): void {
    this.withImmediateWrite(() => {
      this.db.prepare(`UPDATE topic_jobs SET state='pending', lease_owner=NULL, lease_expires_at=NULL,
        attempt_count=MAX(attempt_count-1, 0), updated_at=? WHERE job_key=? AND state='running'`).run(now, jobKey);
    });
  }

  // ─── Schedule state (deployment lease, fair-scan cursor) ─────────────────

  getScheduleState<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM topic_schedule_state WHERE key=?').get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value_json) as T; } catch { return undefined; }
  }

  setScheduleState(key: string, value: unknown, now: string): void {
    this.withImmediateWrite(() => this.writeScheduleStateUnlocked(key, value, now));
  }

  /** Raw upsert for use INSIDE an existing withImmediateWrite transaction. */
  private writeScheduleStateUnlocked(key: string, value: unknown, now: string): void {
    this.db.prepare(`INSERT INTO topic_schedule_state(key, value_json, updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now);
  }

  /** Deployment-level slot lease: cross-process mutual exclusion for one
   * scheduler tick. CAS under the write lock; only the owner may release. */
  tryAcquireDeploymentLease(options: { slotKey: string; owner: string; now: string; ttlMs: number }): DeploymentLeaseResult {
    const key = `lease:${options.slotKey}`;
    let result: DeploymentLeaseResult = { acquired: false };
    this.withImmediateWrite(() => {
      const current = this.getScheduleState<DeploymentLeaseValue>(key);
      if (current && current.owner !== options.owner && Date.parse(current.expiresAt) > Date.parse(options.now)) {
        result = { acquired: false, holder: current.owner, expiresAt: current.expiresAt };
        return;
      }
      const value: DeploymentLeaseValue = {
        owner: options.owner,
        expiresAt: new Date(Date.parse(options.now) + options.ttlMs).toISOString(),
      };
      this.writeScheduleStateUnlocked(key, value, options.now);
      result = { acquired: true, expiresAt: value.expiresAt };
    });
    return result;
  }

  releaseDeploymentLease(slotKey: string, owner: string, now: string): void {
    const key = `lease:${slotKey}`;
    this.withImmediateWrite(() => {
      const current = this.getScheduleState<DeploymentLeaseValue>(key);
      if (!current || current.owner !== owner) return;
      this.writeScheduleStateUnlocked(key, { owner: '', expiresAt: new Date(0).toISOString() }, now);
    });
  }
}
