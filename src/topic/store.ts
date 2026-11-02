import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { Topic, TopicSummary } from '../types.js';
import { topicIdentity } from './identity.js';
import { coversCursor, decodeCursor, normalizeTime } from './source.js';

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
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** All durable writes are serialized in a single immediate transaction. No Session store writes. */
export class TopicStore {
  private readonly db: DatabaseSyncLike;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabaseSyncOrThrow(path);
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > 1) throw new Error('unsupported_topic_schema');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic_documents (key TEXT PRIMARY KEY, chat TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS topic_chat ON topic_documents(chat);
        CREATE TABLE IF NOT EXISTS topic_operations (topic TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(topic, operation));
        CREATE TABLE IF NOT EXISTS topic_tombstones (topic TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(topic, message));
        CREATE TABLE IF NOT EXISTS topic_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO topic_meta VALUES ('generation', 0);
        PRAGMA user_version=1;
      `);
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

  private write(topic: Topic): void {
    this.db.prepare('INSERT INTO topic_documents VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body=excluded.body')
      .run(topic.topicKey, topic.chatId, JSON.stringify(topic));
    this.db.prepare("UPDATE topic_meta SET value=value+1 WHERE key='generation'").run();
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

  observe(key: string, observation: { createdAt?: string; latestAt?: string; checkedAt: string }): Topic {
    return this.transaction(() => {
      const topic = this.require(key);
      const before = JSON.stringify([topic.topicCreatedAt, topic.latestMessageAt]);
      if (observation.createdAt && !topic.topicCreatedAt) topic.topicCreatedAt = normalizeTime(observation.createdAt);
      if (observation.latestAt) {
        const latest = normalizeTime(observation.latestAt);
        if (!topic.latestMessageAt || latest > topic.latestMessageAt) topic.latestMessageAt = latest;
      }
      topic.lastCheckedAt = normalizeTime(observation.checkedAt);
      if (before !== JSON.stringify([topic.topicCreatedAt, topic.latestMessageAt])) topic.revision++;
      // Observing a source never acknowledges successful model processing.
      this.write(topic);
      return topic;
    });
  }

  private require(key: string): Topic {
    const topic = this.read(key);
    if (!topic) throw new Error('topic_not_found');
    return topic;
  }

  commit(input: TopicCommit): 'committed' | 'duplicate' | 'conflict' {
    return this.transaction(() => {
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
      this.db.prepare('INSERT INTO topic_operations VALUES (?, ?)').run(input.topicKey, input.operationId);
      return 'committed';
    });
  }

  invalidate(key: string, messageIds: readonly string[], now: string): void {
    this.transaction(() => {
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
