import { TopicSourceReviewQueue, TOPIC_REVIEW_SCHEMA } from './source-review.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { Topic, TopicSummary } from '../types.js';
import { TopicEmbeddingQueue, TOPIC_EMBEDDING_SCHEMA } from './embedding.js';
import type { TopicModelProfile } from './config.js';
import { topicIdentity } from './identity.js';
import { TopicJobQueue, TOPIC_JOB_SCHEMA, type TopicClaim, type TopicLease } from './jobs.js';
import { coversCursor, decodeCursor, normalizeTime, type TopicSourceCheckpoint, type TopicMessage, topicSourceFingerprint } from './source.js';

export interface TopicSeed {
  chatId: string;
  rootMessageId: string;
  title: string;
  accessPolicyRef: string;
  larkThreadId?: string;
  coverageStartAt?: string;
}
export type TopicMutation =
  | { op: 'noop' }
  | { op: 'add'; text: string; keywords: string[]; sourceMessageIds: string[] }
  | { op: 'update'; id: string; text: string; keywords: string[]; sourceMessageIds: string[] };

export interface TopicCommit {
  topicKey: string;
  expectedRevision: number;
  operationId: string;
  mutations: TopicMutation[];
  verifiedMessageIds: readonly string[];
  cursor: string;
  generatorKey: string;
  now: string;
  sourceCheckpoint?: TopicSourceCheckpoint | null;
  continuation?: { maxSteps: number };
  processedSources?: TopicMessage[];
  embeddingProfile?: TopicModelProfile;
}

export interface TopicSourceProgress {
  kind: 'source-progress';
  checkpoint: TopicSourceCheckpoint | null;
  maxSteps: number;
}
export type TopicJobResult = TopicCommit | TopicSourceProgress | null;

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** All durable writes are serialized in a single immediate transaction. No Session store writes. */
export class TopicStore {
  private readonly db: DatabaseSyncLike;
  readonly jobs: TopicJobQueue;
  readonly reviews: TopicSourceReviewQueue;
  readonly embeddings: TopicEmbeddingQueue;

  constructor(readonly path: string, clock: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabaseSyncOrThrow(path);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 8) throw new Error('unsupported_topic_schema');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic_documents (key TEXT PRIMARY KEY, chat TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS topic_chat ON topic_documents(chat);
        CREATE TABLE IF NOT EXISTS topic_operations (topic TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(topic, operation));
        CREATE TABLE IF NOT EXISTS topic_tombstones (topic TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(topic, message));
        CREATE TABLE IF NOT EXISTS topic_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO topic_meta VALUES ('generation', 0);
        ${TOPIC_JOB_SCHEMA}
        CREATE TABLE IF NOT EXISTS topic_source_scans (topic TEXT PRIMARY KEY, body TEXT NOT NULL);

      `);
      const jobColumns = this.db.prepare('PRAGMA table_info(topic_jobs)').all() as Array<{ name: string }>;
      for (const field of ['step', 'failures']) {
        if (!jobColumns.some(column => column.name === field)) this.db.exec(`ALTER TABLE topic_jobs ADD COLUMN ${field} INTEGER NOT NULL DEFAULT 0`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS topic_source_fingerprints (topic TEXT NOT NULL, message TEXT NOT NULL, hash TEXT NOT NULL, created TEXT NOT NULL, checked TEXT NOT NULL, PRIMARY KEY(topic, message)); ${TOPIC_EMBEDDING_SCHEMA} CREATE TABLE IF NOT EXISTS topic_maintenance (key TEXT PRIMARY KEY, value TEXT NOT NULL); ${TOPIC_REVIEW_SCHEMA} PRAGMA user_version=8;`);
      this.jobs = new TopicJobQueue(this.db, action => this.transaction(action), clock);
      this.reviews = new TopicSourceReviewQueue(this.db, action => this.transaction(action), claim => this.jobs.assertClaim(claim));
      this.embeddings = new TopicEmbeddingQueue(this.db, action => this.transaction(action), key => this.read(key), topic => this.write(topic), lease => this.jobs.valid(lease), clock);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private write(topic: Topic, searchableChange = true): void {
    this.db.prepare('INSERT INTO topic_documents VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body=excluded.body')
      .run(topic.topicKey, topic.chatId, JSON.stringify(topic));
    if (searchableChange) this.db.prepare("UPDATE topic_meta SET value=value+1 WHERE key='generation'").run();
  }

  generation(): number {
    return Number((this.db.prepare("SELECT value FROM topic_meta WHERE key='generation'").get() as { value: number }).value);
  }

  read(key: string): Topic | null {
    const row = this.db.prepare('SELECT body FROM topic_documents WHERE key=?').get(key) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Topic : null;
  }

  list(): Topic[] {
    return (this.db.prepare('SELECT body FROM topic_documents ORDER BY key').all() as Array<{ body: string }>)
      .map(row => JSON.parse(row.body) as Topic);
  }

  /** Directory keys do not deserialize every summary/vector to schedule source work. */
  keysForChats(chatIds: readonly string[]): string[] {
    if (!chatIds.length) return [];
    return (this.db.prepare(`SELECT key FROM topic_documents WHERE chat IN (${chatIds.map(() => '?').join(',')}) ORDER BY key`).all(...chatIds) as Array<{ key: string }>).map(row => row.key);
  }

  /** Bounded keyset traversal shared by local maintenance/reindex; resumes fairly after a restart. */
  maintenancePage(lease: TopicLease, task: string, limit = 20): Topic[] {
    return this.transaction(() => {
      if (!this.jobs.valid(lease)) throw new Error('stale_topic_maintenance');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_topic_maintenance_budget');
      const after = (this.db.prepare('SELECT value FROM topic_maintenance WHERE key=?').get(task) as { value: string } | undefined)?.value ?? '';
      const rows = this.db.prepare('SELECT key FROM topic_documents WHERE key>? ORDER BY key LIMIT ?').all(after, limit) as Array<{ key: string }>;
      this.db.prepare('INSERT INTO topic_maintenance VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(task, rows.length === limit ? rows.at(-1)!.key : '');
      return rows.map(row => this.require(row.key));
    });
  }

  /** Explicit TTL is measured from each summary's last successful content update, not source time.
   * Keep topic identity, successful cursor, source fingerprints and idempotency receipts: expiry
   * is not deletion of upstream messages and must neither replay old adds nor restart backfill.
   */
  expireSummaries(lease: TopicLease, keys: readonly string[], retentionDays: number | null, now: string): number {
    return this.transaction(() => {
      if (!this.jobs.valid(lease)) throw new Error('stale_topic_maintenance');
      if (retentionDays === null) return 0;
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('invalid_topic_retention');
      const cutoff = Date.parse(normalizeTime(now)) - retentionDays * 86_400_000;
      let removed = 0;
      for (const key of new Set(keys)) {
        const topic = this.read(key); if (!topic) continue;
        const expired = topic.summaries.filter(summary => Date.parse(summary.updatedAt) <= cutoff);
        if (!expired.length) continue;
        const ids = new Set(expired.map(summary => summary.id));
        topic.summaries = topic.summaries.filter(summary => !ids.has(summary.id));
        for (const id of ids) this.db.prepare('DELETE FROM topic_embedding_jobs WHERE topic=? AND summary=?').run(key, id);
        // CAS also fences model calls that started before cleanup and still refer to expired text.
        topic.revision++; topic.updatedAt = normalizeTime(now); this.write(topic); removed += expired.length;
      }
      return removed;
    });
  }

  authorizedTopics(chatIds: readonly string[] | null, limit: number): { topics: Topic[]; truncated: boolean } {
    if (chatIds?.length === 0) return { topics: [], truncated: false };
    const where = chatIds ? ` WHERE chat IN (${chatIds.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(`SELECT key, length(CAST(body AS BLOB)) AS size FROM topic_documents${where} ORDER BY key LIMIT ?`).all(...(chatIds ?? []), limit + 1) as Array<{ key: string; size: number }>;
    const topics: Topic[] = []; let bytes = 0, truncated = rows.length > limit;
    for (const row of rows.slice(0, limit)) {
      bytes += row.size;
      if (bytes > 32 * 1024 * 1024) { truncated = true; break; }
      const topic = this.read(row.key); if (topic) topics.push(topic);
    }
    return { topics, truncated };
  }

  discover(seed: TopicSeed, now: string): Topic {
    const identity = topicIdentity(seed);
    if (!identity) throw new Error('invalid_thread_identity');
    return this.transaction(() => {
      const current = this.read(identity.topicKey);
      if (current) {
        // Discovery may rename a directory entry, never relocate its summaries or reset its cursor.
        if (seed.title !== current.title || (identity.nativeThreadId && identity.nativeThreadId !== current.nativeThreadId)) {
          current.title = seed.title;
          if (identity.nativeThreadId) current.nativeThreadId = identity.nativeThreadId;
          current.revision++;
          current.updatedAt = normalizeTime(now);
          this.write(current);
        }
        return current;
      }
      const topic: Topic = {
        ...identity, schemaVersion: 1, title: seed.title, accessPolicyRef: seed.accessPolicyRef,
        revision: 0, summaries: [], updatedAt: normalizeTime(now),
        ...(seed.coverageStartAt ? { coverageStartAt: normalizeTime(seed.coverageStartAt) } : {}),
      };
      this.write(topic);
      return topic;
    });
  }

  observe(key: string, observation: { createdAt?: string; latestAt?: string; checkedAt: string; nativeThreadId?: string }, claim?: TopicClaim): Topic {
    return this.transaction(() => {
      const topic = this.require(key);
      if (claim) {
        this.jobs.assertClaim(claim);
        if (claim.job.topicKey !== key) throw new Error('topic_claim_mismatch');
      }
      const before = JSON.stringify([topic.topicCreatedAt, topic.latestMessageAt, topic.nativeThreadId]);
      if (observation.nativeThreadId) {
        if (!/^omt_[A-Za-z0-9_-]+$/.test(observation.nativeThreadId) || (topic.nativeThreadId && topic.nativeThreadId !== observation.nativeThreadId)) throw new Error('topic_source_native_changed');
        topic.nativeThreadId = observation.nativeThreadId;
      }
      if (observation.createdAt && !topic.topicCreatedAt) topic.topicCreatedAt = normalizeTime(observation.createdAt);
      if (observation.latestAt) {
        const latest = normalizeTime(observation.latestAt);
        if (!topic.latestMessageAt || latest > topic.latestMessageAt) topic.latestMessageAt = latest;
      }
      topic.lastCheckedAt = normalizeTime(observation.checkedAt);
      const changed = before !== JSON.stringify([topic.topicCreatedAt, topic.latestMessageAt, topic.nativeThreadId]);
      if (changed) topic.revision++;
      // Check timestamps alone do not invalidate a user's search pagination snapshot.
      this.write(topic, changed);
      return topic;
    });
  }

  private require(key: string): Topic {
    const topic = this.read(key);
    if (!topic) throw new Error('topic_not_found');
    return topic;
  }

  commit(input: TopicCommit): 'committed' | 'duplicate' | 'conflict' {
    return this.transaction(() => this.commitInsideTransaction(input));
  }

  /** Content, successful cursor, operation receipt and job completion are one SQLite commit. */
  settle(claim: TopicClaim, input: TopicJobResult, skipped = false): 'committed' | 'duplicate' | 'conflict' {
    return this.transaction(() => {
      this.jobs.assertClaim(claim);
      if (input && 'kind' in input) {
        const topic = this.require(claim.job.topicKey);
        if (input.checkpoint && input.checkpoint.baseCursor !== (topic.summarizedThroughCursor ?? null)) return 'conflict';
        this.writeCheckpoint(claim.job.topicKey, input.checkpoint);
        if (input.checkpoint) this.jobs.continueInsideTransaction(claim, input.maxSteps);
        else this.jobs.finishInsideTransaction(claim, 'done');
        return 'committed';
      }
      if (input && input.topicKey !== claim.job.topicKey) throw new Error('topic_claim_mismatch');
      const result = input ? this.commitInsideTransaction(input) : 'committed';
      if (result !== 'conflict') {
        if (input?.continuation && !skipped) this.jobs.continueInsideTransaction(claim, input.continuation.maxSteps);
        else this.jobs.finishInsideTransaction(claim, skipped ? 'skipped' : 'done');
      }
      return result;
    });
  }

  private commitInsideTransaction(input: TopicCommit): 'committed' | 'duplicate' | 'conflict' {
    const topic = this.require(input.topicKey);
    if (this.db.prepare('SELECT 1 FROM topic_operations WHERE topic=? AND operation=?').get(input.topicKey, input.operationId)) return 'duplicate';
    if (topic.revision !== input.expectedRevision) return 'conflict';
    const cursor = decodeCursor(input.cursor);
    if (topic.summarizedThroughCursor && !coversCursor(cursor, decodeCursor(topic.summarizedThroughCursor))) throw new Error('cursor_regressed');
    const allowed = new Set([...input.verifiedMessageIds, ...topic.summaries.flatMap(summary => summary.sourceMessageIds)]);
    const updated = new Set<string>();
    for (const mutation of input.mutations) {
      if (mutation.op === 'noop') continue;
      if (!mutation.text.trim() || mutation.text.length > 8000 || mutation.keywords.length > 32 || !mutation.sourceMessageIds.length) throw new Error('invalid_summary');
      for (const id of mutation.sourceMessageIds) {
        if (!allowed.has(id)) throw new Error('invalid_summary_source');
        if (this.db.prepare('SELECT 1 FROM topic_tombstones WHERE topic=? AND message=?').get(input.topicKey, id)) throw new Error('deleted_summary_source');
      }
      let previous: TopicSummary | undefined;
      if (mutation.op === 'update') {
        previous = topic.summaries.find(summary => summary.id === mutation.id);
        if (!previous || updated.has(mutation.id)) throw new Error('invalid_summary_update');
        updated.add(mutation.id);
      }
      const summary: TopicSummary = {
        id: previous?.id ?? randomUUID(), text: mutation.text.trim(),
        keywords: [...new Set(mutation.keywords.map(keyword => keyword.trim()).filter(Boolean))],
        sourceMessageIds: [...new Set(mutation.sourceMessageIds)],
        updatedAt: normalizeTime(input.now), generatorKey: input.generatorKey,
      };
      if (previous?.text === summary.text && previous.embedding) summary.embedding = previous.embedding;
      if (previous) topic.summaries[topic.summaries.indexOf(previous)] = summary;
      else topic.summaries.push(summary);
    }
    topic.summarizedThroughCursor = input.cursor;
    topic.sourceThroughAt = cursor.time;
    topic.updatedAt = normalizeTime(input.now);
    topic.revision++;
    this.write(topic);
    for (const source of input.processedSources ?? []) {
      this.db.prepare('INSERT INTO topic_source_fingerprints VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic, message) DO UPDATE SET hash=excluded.hash, checked=excluded.checked')
        .run(input.topicKey, source.id, topicSourceFingerprint(source), source.createdAt, input.now);
    }
    if (input.embeddingProfile) this.embeddings.enqueueInsideTransaction(topic, input.embeddingProfile);
    if (input.sourceCheckpoint !== undefined) this.writeCheckpoint(input.topicKey, input.sourceCheckpoint);
    this.db.prepare('INSERT INTO topic_operations VALUES (?, ?)').run(input.topicKey, input.operationId);
    return 'committed';
  }

  beginSource(claim: TopicClaim, lookbackDays: number, now: string): Topic {
    return this.transaction(() => {
      this.jobs.assertClaim(claim);
      const topic = this.require(claim.job.topicKey);
      if (!topic.coverageStartAt) {
        topic.coverageStartAt = new Date(Date.parse(normalizeTime(now)) - lookbackDays * 86_400_000).toISOString();
        topic.revision++;
        this.write(topic);
      }
      return topic;
    });
  }

  sourceCheckpoint(key: string): TopicSourceCheckpoint | null {
    const row = this.db.prepare('SELECT body FROM topic_source_scans WHERE topic=?').get(key) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as TopicSourceCheckpoint : null;
  }

  private writeCheckpoint(key: string, checkpoint: TopicSourceCheckpoint | null): void {
    if (checkpoint === null) this.db.prepare('DELETE FROM topic_source_scans WHERE topic=?').run(key);
    else this.db.prepare('INSERT INTO topic_source_scans VALUES (?, ?) ON CONFLICT(topic) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(checkpoint));
  }

  /** Only traversed already-processed history may checkpoint without a successful model commit. */
  saveSourceProgress(claim: TopicClaim, checkpoint: TopicSourceCheckpoint | null): void {
    this.transaction(() => {
      this.jobs.assertClaim(claim);
      const topic = this.require(claim.job.topicKey);
      if (checkpoint && checkpoint.baseCursor !== (topic.summarizedThroughCursor ?? null)) throw new Error('topic_scan_cursor_mismatch');
      this.writeCheckpoint(claim.job.topicKey, checkpoint);
    });
  }

  sourceChanged(key: string, message: TopicMessage): boolean {
    const row = this.db.prepare('SELECT hash FROM topic_source_fingerprints WHERE topic=? AND message=?').get(key, message.id) as { hash: string } | undefined;
    return !!row && row.hash !== topicSourceFingerprint(message);
  }

  /** Invalidate stale evidence immediately; only a successful model commit acknowledges edited content. */
  reconcileSources(claim: TopicClaim, messages: readonly TopicMessage[], now: string): void {
    this.transaction(() => {
      this.jobs.assertClaim(claim);
      const topic = this.require(claim.job.topicKey);
      const changed = new Set<string>();
      for (const message of messages) {
        if (message.deleted || this.sourceChanged(topic.topicKey, message)) changed.add(message.id);
        if (message.deleted) this.db.prepare('INSERT OR IGNORE INTO topic_tombstones VALUES (?, ?)').run(topic.topicKey, message.id);
        if (!this.sourceChanged(topic.topicKey, message)) this.db.prepare('UPDATE topic_source_fingerprints SET checked=? WHERE topic=? AND message=?').run(now, topic.topicKey, message.id);
      }
      const summaries = topic.summaries.filter(summary => !summary.sourceMessageIds.some(id => changed.has(id)));
      if (changed.size > 0) {
        topic.summaries = summaries; topic.revision++; topic.updatedAt = normalizeTime(now); this.write(topic);
      }
    });
  }

  invalidate(key: string, messageIds: readonly string[], now: string, claim?: TopicClaim): void {
    this.transaction(() => {
      if (claim) {
        this.jobs.assertClaim(claim);
        if (claim.job.topicKey !== key) throw new Error('topic_claim_mismatch');
      }
      const topic = this.require(key);
      for (const id of messageIds) this.db.prepare('INSERT OR IGNORE INTO topic_tombstones VALUES (?, ?)').run(key, id);
      topic.summaries = topic.summaries.filter(summary => !summary.sourceMessageIds.some(id => messageIds.includes(id)));
      topic.revision++;
      topic.updatedAt = normalizeTime(now);
      this.write(topic);
    });
  }

  saveEmbedding(key: string, id: string, embedding: NonNullable<TopicSummary['embedding']>): boolean {
    return this.transaction(() => {
      const topic = this.require(key);
      const summary = topic.summaries.find(item => item.id === id);
      if (!summary || contentHash(summary.text) !== embedding.contentHash) return false;
      if (!embedding.modelKey || !embedding.vector.length || embedding.vector.some(value => !Number.isFinite(value))) throw new Error('invalid_embedding');
      summary.embedding = embedding;
      this.write(topic);
      return true;
    });
  }
}
