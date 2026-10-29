/**
 * 话题知识存储（独立 SQLite 库，与 session 存储无耦合）。
 *
 * 为什么独立库：Topic 是**可重建的派生数据**，不能绑进 Session 的权威存储；停用功能
 * 或清空索引都不该动到会话记录（spec §9 回滚）。这里只复用 `services/sqlite-compat`
 * 的引擎兼容层，不复用任何 session 迁移/业务规则。
 *
 * 两条并发语义（写在这里是为了让调用方知道该怎么用，而不是靠读实现猜）：
 * - 摘要提交是 **revision CAS**：`commitSummaryMutation` 带 `expectedRevision`，冲突时
 *   不覆盖别人刚写的结果，只回报当前 revision 让调用方重新读取后再决定。
 * - 定时槽位是 **租约**：同一 `slotId` 只有一个 owner 能拿到；owner 崩溃后租约到期可
 *   被接管（`acquireSlot` 的 `taken_over` 分支），不需要人工清理。
 *
 * 数据目录走 `resolveBotmuxDataDir()`，因此编译态也落在真实目录里（不拼 `__dirname`）。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { openDatabaseSyncOrThrow, sqliteEngineAvailable, type DatabaseSyncLike } from '../services/sqlite-compat.js';
import type { Topic, TopicSummary } from '../types.js';
import type { SummaryMutation } from './model-client.js';
import { decodeCursor, encodeCursor } from './source.js';
import { summaryContentHash } from './vector.js';

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 3_000;
export const TOPIC_STORE_FILENAME = 'topic-search.sqlite';

export class TopicStoreUnavailableError extends Error {
  constructor(message = 'SQLite engine unavailable for the topic store') {
    super(message);
    this.name = 'TopicStoreUnavailableError';
  }
}

interface TopicRow {
  topic_key: string;
  schema_version: number;
  chat_id: string;
  root_message_id: string;
  native_thread_id: string | null;
  title: string;
  access_policy_ref: string;
  revision: number;
  summarized_through_cursor: string | null;
  coverage_start_at: string | null;
  source_through_at: string | null;
  last_checked_at: string | null;
  updated_at: string;
}

interface SummaryRow {
  summary_id: string;
  topic_key: string;
  text: string;
  keywords: string;
  source_message_ids: string;
  updated_at: string;
  generator_key: string;
}

interface EmbeddingRow {
  summary_id: string;
  model_key: string;
  content_hash: string;
  vector: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS topics (
  topic_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  native_thread_id TEXT,
  title TEXT NOT NULL,
  access_policy_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  summarized_through_cursor TEXT,
  coverage_start_at TEXT,
  source_through_at TEXT,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_summaries (
  summary_id TEXT PRIMARY KEY,
  topic_key TEXT NOT NULL,
  text TEXT NOT NULL,
  keywords TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generator_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_summaries_topic ON topic_summaries(topic_key);
CREATE TABLE IF NOT EXISTS topic_summary_embeddings (
  summary_id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_deleted_messages (
  topic_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (topic_key, message_id)
);
CREATE TABLE IF NOT EXISTS topic_summary_sources (
  summary_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  create_time TEXT NOT NULL,
  PRIMARY KEY (summary_id, message_id)
);
CREATE TABLE IF NOT EXISTS topic_deletion_epochs (
  topic_key TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_jobs (
  topic_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT,
  error_code TEXT,
  last_outcome TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS topic_schedule_slots (
  slot_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  started_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS topic_schedule_state (
  state_key TEXT PRIMARY KEY,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);
`;

function parseJsonArray<T>(value: unknown, guard: (item: unknown) => item is T): T[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(guard);
  } catch {
    return [];
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface TopicDirectoryInput {
  topicKey: string;
  chatId: string;
  rootMessageId: string;
  nativeThreadId?: string;
  title: string;
  accessPolicyRef: string;
  now: string;
  /** 首次覆盖起点（只在创建时写入，后续不覆盖）。 */
  coverageStartAt?: string;
}

export interface CommitSummaryMutationInput {
  topicKey: string;
  expectedRevision: number;
  mutations: readonly SummaryMutation[];
  /** 本批消息的 id → createTime；用于删除重叠窗口的后续核查。 */
  sourceMessageTimes?: Readonly<Record<string, string>>;
  /** 失效前捕获的删除 epoch；不一致说明期间发生了删除，整批不得落盘。 */
  expectedDeletionEpoch?: number;
  /** 提交成功后写入的源游标（编码后的不透明字符串）。 */
  nextCursor: string;
  sourceThroughAt: string;
  generatorKey: string;
  now: string;
}

export type CommitSummaryMutationResult =
  | {
    status: 'committed';
    revision: number;
    summaries: TopicSummary[];
    /** 实际落库的变更条数。 */
    applied: { added: number; updated: number };
  }
  | { status: 'conflict'; revision: number }
  | {
    status: 'blocked';
    reason: 'tombstoned' | 'stale_epoch' | 'cursor_regressed';
    revision: number;
  }
  | { status: 'missing' };

export interface SlotAcquireInput {
  slotId: string;
  owner: string;
  now: string;
  leaseMs: number;
}

export type SlotAcquireResult =
  | { acquired: true; mode: 'new' | 'taken_over' }
  | { acquired: false; reason: 'already_finished' | 'lease_held' };

export interface EmbeddingTask {
  topicKey: string;
  summaryId: string;
  text: string;
}

export interface TopicJobState {
  topicKey: string;
  attempts: number;
  nextAttemptAt?: string;
  errorCode?: string;
  lastOutcome?: string;
  updatedAt: string;
}

export interface TopicStore {
  readonly path: string;
  listTopics(options?: { limit?: number }): Topic[];
  getTopic(topicKey: string): Topic | null;
  upsertTopicDirectory(input: TopicDirectoryInput): Topic;
  commitSummaryMutation(input: CommitSummaryMutationInput): CommitSummaryMutationResult;
  /**
   * 源侧确认某些消息已删除：删掉引用了它们的摘要（连同向量）。与摘要提交分开，
   * 因此即使本轮模型调用失败，已删除内容也不会继续被检索到。
   * 只递增 revision，不动游标 —— 游标推进仍由成功提交独占。
   */
  invalidateSummariesForMessages(input: {
    topicKey: string;
    messageIds: readonly string[];
    now: string;
  }): { invalidated: number; revision: number; epoch: number };
  /** 当前 topic 的删除 epoch（每次失效递增）。 */
  deletionEpoch(topicKey: string): number;
  /** 某时间点之后仍未失效的摘要来源（用于重叠窗口核查删除）。 */
  summariesReferencingSince(
    topicKey: string,
    sinceIso: string,
  ): Array<{ summaryId: string; messageId: string; createTime: string }>;
  recordCheck(input: { topicKey: string; checkedAt: string; coverageStartAt?: string }): void;
  markSummaryEmbedding(input: {
    topicKey: string;
    summaryId: string;
    modelKey: string;
    contentHash: string;
    vector: readonly number[];
    now: string;
  }): boolean;
  pendingEmbeddingTasks(limit: number): EmbeddingTask[];
  jobState(topicKey: string): TopicJobState | null;
  recordJobFailure(input: { topicKey: string; errorCode: string; nextAttemptAt?: string; now: string }): void;
  clearJobFailure(topicKey: string, now: string): void;
  acquireSlot(input: SlotAcquireInput): SlotAcquireResult;
  finishSlot(input: { slotId: string; owner: string; status: 'ok' | 'error'; errorCode?: string; now: string }): boolean;
  pruneSlots(before: string): number;
  /** 周期性调度「下一次该跑的时刻」（持久化，重启后继续）。 */
  getNextRunAt(): string | null;
  setNextRunAt(nextRunAt: string, now: string): void;
  deleteTopic(topicKey: string): void;
  close(): void;
}

export function topicStorePath(dataDir: string = resolveBotmuxDataDir()): string {
  return join(dataDir, TOPIC_STORE_FILENAME);
}

export interface OpenTopicStoreOptions {
  /** 显式路径（测试用）；缺省走 `topicStorePath(dataDir)`。 */
  path?: string;
  dataDir?: string;
}

export function openTopicStore(options: OpenTopicStoreOptions = {}): TopicStore {
  if (!sqliteEngineAvailable()) throw new TopicStoreUnavailableError();
  const path = options.path ?? topicStorePath(options.dataDir ?? resolveBotmuxDataDir());
  mkdirSync(dirname(path), { recursive: true });
  const db: DatabaseSyncLike = openDatabaseSyncOrThrow(path);
  // busy_timeout 必须第一条：否则并发打开会在第一条 DDL 上直接 SQLITE_BUSY。
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);

  function inTransaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = operation();
      db.exec('COMMIT');
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // 事务已经终止（例如 BEGIN 失败后的隐式回滚）：吞掉 rollback 错误，
          // 让原始异常往上抛。
        }
      }
    }
  }

  function readSummaryRows(topicKey?: string): SummaryRow[] {
    if (topicKey === undefined) {
      return db.prepare('SELECT * FROM topic_summaries').all() as SummaryRow[];
    }
    return db
      .prepare('SELECT * FROM topic_summaries WHERE topic_key = ?')
      .all(topicKey) as SummaryRow[];
  }

  function readEmbeddingRows(): Map<string, EmbeddingRow> {
    const rows = db.prepare('SELECT * FROM topic_summary_embeddings').all() as EmbeddingRow[];
    return new Map(rows.map(row => [row.summary_id, row]));
  }

  /**
   * 游标合并：只允许前进。同一毫秒取两侧 id 并集（该毫秒上处理过的消息都要记下），
   * 更早的边界一律视为迟到批次，由调用方整批丢弃。
   */
  function mergeCursor(
    previous: string | null,
    next: string,
  ): { cursor: string; regressed: boolean } {
    const before = decodeCursor(previous);
    const after = decodeCursor(next);
    if (!before || !after) return { cursor: next, regressed: false };
    const order = after.createTime.localeCompare(before.createTime);
    if (order < 0) return { cursor: previous ?? next, regressed: true };
    if (order === 0) {
      return {
        cursor: encodeCursor({
          createTime: after.createTime,
          messageIds: [...new Set([...before.messageIds, ...after.messageIds])],
        }),
        regressed: false,
      };
    }
    return { cursor: next, regressed: false };
  }

  /** 摘要 → 来源消息时间表：重叠窗口核查删除时，才知道哪些引用落在窗口内。 */
  function replaceSummarySources(
    summaryId: string,
    messageIds: readonly string[],
    previousTimes: ReadonlyMap<string, string>,
    input: CommitSummaryMutationInput,
  ): void {
    db.prepare('DELETE FROM topic_summary_sources WHERE summary_id = ?').run(summaryId);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO topic_summary_sources (summary_id, message_id, create_time)
         VALUES (?, ?, ?)`,
    );
    for (const messageId of messageIds) {
      const createTime =
        input.sourceMessageTimes?.[messageId] ?? previousTimes.get(messageId) ?? input.sourceThroughAt;
      insert.run(summaryId, messageId, createTime);
    }
  }

  /**
   * 组装 Topic。向量只在 `contentHash` 与**当前正文**一致时才挂上：这样「正文已改、
   * 向量还没重算」和「迟到的旧向量」两种情况都自动不可用，不需要额外失效写入。
   */
  function buildTopic(
    row: TopicRow,
    summaries: SummaryRow[],
    embeddings: Map<string, EmbeddingRow>,
  ): Topic {
    const items: TopicSummary[] = summaries.map(summary => {
      const keywords = parseJsonArray(summary.keywords, isString);
      const sourceMessageIds = parseJsonArray(summary.source_message_ids, isString);
      const embeddingRow = embeddings.get(summary.summary_id);
      const hash = summaryContentHash(summary.text);
      const usableEmbedding =
        embeddingRow && embeddingRow.content_hash === hash
          ? {
              modelKey: embeddingRow.model_key,
              contentHash: embeddingRow.content_hash,
              vector: parseJsonArray(embeddingRow.vector, isFiniteNumber),
            }
          : undefined;
      return {
        id: summary.summary_id,
        text: summary.text,
        keywords,
        sourceMessageIds,
        updatedAt: summary.updated_at,
        generatorKey: summary.generator_key,
        ...(usableEmbedding && usableEmbedding.vector.length > 0 ? { embedding: usableEmbedding } : {}),
      };
    });
    return {
      schemaVersion: 1,
      topicKey: row.topic_key,
      chatId: row.chat_id,
      rootMessageId: row.root_message_id,
      ...(row.native_thread_id ? { nativeThreadId: row.native_thread_id } : {}),
      title: row.title,
      accessPolicyRef: row.access_policy_ref,
      revision: row.revision,
      summaries: items,
      ...(row.summarized_through_cursor ? { summarizedThroughCursor: row.summarized_through_cursor } : {}),
      ...(row.coverage_start_at ? { coverageStartAt: row.coverage_start_at } : {}),
      ...(row.source_through_at ? { sourceThroughAt: row.source_through_at } : {}),
      ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
      updatedAt: row.updated_at,
    };
  }

  const store: TopicStore = {
    path,

    listTopics(options = {}) {
      const limit = options.limit;
      const rows =
        limit === undefined
          ? (db.prepare('SELECT * FROM topics ORDER BY topic_key').all() as TopicRow[])
          : (db.prepare('SELECT * FROM topics ORDER BY topic_key LIMIT ?').all(
              Math.max(1, Math.floor(limit)),
            ) as TopicRow[]);
      const embeddings = readEmbeddingRows();
      const summariesByTopic = new Map<string, SummaryRow[]>();
      for (const summary of readSummaryRows()) {
        const bucket = summariesByTopic.get(summary.topic_key);
        if (bucket) bucket.push(summary);
        else summariesByTopic.set(summary.topic_key, [summary]);
      }
      return rows.map(row => buildTopic(row, summariesByTopic.get(row.topic_key) ?? [], embeddings));
    },

    getTopic(topicKey) {
      const row = db.prepare('SELECT * FROM topics WHERE topic_key = ?').get(topicKey) as TopicRow | undefined;
      if (!row) return null;
      return buildTopic(row, readSummaryRows(topicKey), readEmbeddingRows());
    },

    upsertTopicDirectory(input) {
      return inTransaction(() => {
        const existing = db
          .prepare('SELECT * FROM topics WHERE topic_key = ?')
          .get(input.topicKey) as TopicRow | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO topics (
               topic_key, schema_version, chat_id, root_message_id, native_thread_id, title,
               access_policy_ref, revision, summarized_through_cursor, coverage_start_at,
               source_through_at, last_checked_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, ?)`,
          ).run(
            input.topicKey,
            SCHEMA_VERSION,
            input.chatId,
            input.rootMessageId,
            input.nativeThreadId ?? null,
            input.title,
            input.accessPolicyRef,
            input.coverageStartAt ?? null,
            input.now,
          );
          return this.getTopic(input.topicKey) as Topic;
        }
        // 目录刷新只更新「源元数据」：标题/原生 thread id/授权引用。
        // 摘要、游标与 revision 由 commitSummaryMutation 独占，这里绝不碰。
        db.prepare(
          `UPDATE topics
              SET title = ?, native_thread_id = CASE WHEN ? IS NULL THEN native_thread_id ELSE ? END,
                  access_policy_ref = ?,
                  coverage_start_at = COALESCE(coverage_start_at, ?),
                  updated_at = ?
            WHERE topic_key = ?`,
        ).run(
          input.title,
          input.nativeThreadId ?? null,
          input.nativeThreadId ?? null,
          input.accessPolicyRef,
          input.coverageStartAt ?? null,
          input.now,
          input.topicKey,
        );
        return this.getTopic(input.topicKey) as Topic;
      });
    },

    commitSummaryMutation(input) {
      return inTransaction(() => {
        const row = db
          .prepare('SELECT * FROM topics WHERE topic_key = ?')
          .get(input.topicKey) as TopicRow | undefined;
        if (!row) return { status: 'missing' as const };
        const currentRevision = Number(row.revision);
        if (currentRevision !== input.expectedRevision) {
          return { status: 'conflict' as const, revision: currentRevision };
        }

        // 删除 epoch：enrich 期间只要发生过失效，这一批结果就基于旧快照，整批丢弃。
        const epoch = store.deletionEpoch(input.topicKey);
        if (input.expectedDeletionEpoch !== undefined && input.expectedDeletionEpoch !== epoch) {
          return { status: 'blocked' as const, reason: 'stale_epoch' as const, revision: currentRevision };
        }
        // 墓碑兜底：跨进程/重启后 epoch 可能已被重置（话题重建），来源 id 仍能挡住回写。
        const tombstoned = new Set(
          (db.prepare('SELECT message_id FROM topic_deleted_messages WHERE topic_key = ?')
            .all(input.topicKey) as Array<{ message_id: string }>).map(entry => entry.message_id),
        );
        const blockedByTombstone = input.mutations.some(mutation =>
          mutation.op !== 'noop' && mutation.sourceMessageIds.some(id => tombstoned.has(id)));
        if (blockedByTombstone) {
          return { status: 'blocked' as const, reason: 'tombstoned' as const, revision: currentRevision };
        }

        // 游标只能前进：租约到期/多实例交叠时，迟到的旧批次绝不能把边界写回去，
        // 否则下一轮会把已经摘要过的消息再摘要一次。
        const merged = mergeCursor(row.summarized_through_cursor, input.nextCursor);
        if (merged.regressed) {
          return { status: 'blocked' as const, reason: 'cursor_regressed' as const, revision: currentRevision };
        }
        const nextCursor = merged.cursor;

        let appliedAdded = 0;
        let appliedUpdated = 0;
        for (const mutation of input.mutations) {
          if (mutation.op === 'noop') continue;
          if (mutation.op === 'add') {
            const summaryId = `s_${randomUUID()}`;
            db.prepare(
              `INSERT INTO topic_summaries
                 (summary_id, topic_key, text, keywords, source_message_ids, updated_at, generator_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              summaryId,
              input.topicKey,
              mutation.text,
              JSON.stringify(mutation.keywords),
              JSON.stringify(mutation.sourceMessageIds),
              input.now,
              input.generatorKey,
            );
            replaceSummarySources(summaryId, mutation.sourceMessageIds, new Map(), input);
            appliedAdded += 1;
            continue;
          }
          const existing = db
            .prepare('SELECT * FROM topic_summaries WHERE summary_id = ? AND topic_key = ?')
            .get(mutation.id, input.topicKey) as SummaryRow | undefined;
          if (!existing) {
            // 校验阶段已挡过未知 id；这里是 CAS 重读后的兜底：目标被并发删掉就跳过，
            // 不因为一条 update 丢掉整批已成功的摘要。
            continue;
          }
          const previousTimes = new Map(
            (db.prepare('SELECT message_id, create_time FROM topic_summary_sources WHERE summary_id = ?')
              .all(mutation.id) as Array<{ message_id: string; create_time: string }>)
              .map(entry => [entry.message_id, entry.create_time]),
          );
          const textChanged = existing.text !== mutation.text;
          db.prepare(
            `UPDATE topic_summaries
                SET text = ?, keywords = ?, source_message_ids = ?, updated_at = ?, generator_key = ?
              WHERE summary_id = ? AND topic_key = ?`,
          ).run(
            mutation.text,
            JSON.stringify(mutation.keywords),
            JSON.stringify(mutation.sourceMessageIds),
            input.now,
            input.generatorKey,
            mutation.id,
            input.topicKey,
          );
          replaceSummarySources(mutation.id, mutation.sourceMessageIds, previousTimes, input);
          appliedUpdated += 1;
          if (textChanged) {
            // 正文变了：旧向量对新正文无意义，直接删除（读路径还会按 hash 二次校验）。
            db.prepare('DELETE FROM topic_summary_embeddings WHERE summary_id = ?').run(mutation.id);
          }
        }

        const nextRevision = currentRevision + 1;
        db.prepare(
          `UPDATE topics
              SET revision = ?, summarized_through_cursor = ?, source_through_at = ?,
                  last_checked_at = ?, updated_at = ?
            WHERE topic_key = ?`,
        ).run(nextRevision, nextCursor, input.sourceThroughAt, input.now, input.now, input.topicKey);

        const topic = this.getTopic(input.topicKey);
        return {
          status: 'committed' as const,
          revision: nextRevision,
          summaries: topic?.summaries ?? [],
          applied: { added: appliedAdded, updated: appliedUpdated },
        };
      });
    },

    invalidateSummariesForMessages(input) {
      return inTransaction(() => {
        const deleted = new Set(input.messageIds.map(id => id.trim()).filter(Boolean));
        const row = db
          .prepare('SELECT * FROM topics WHERE topic_key = ?')
          .get(input.topicKey) as TopicRow | undefined;
        if (!row) return { invalidated: 0, revision: 0, epoch: 0 };
        if (deleted.size === 0) {
          return { invalidated: 0, revision: Number(row.revision), epoch: store.deletionEpoch(input.topicKey) };
        }

        // epoch 在墓碑之前递增：任何在失效之前读取状态的 enrich 结果，提交时都会
        // 因 epoch 不匹配而整批作废。
        db.prepare(
          `INSERT INTO topic_deletion_epochs (topic_key, epoch) VALUES (?, 1)
           ON CONFLICT(topic_key) DO UPDATE SET epoch = epoch + 1`,
        ).run(input.topicKey);
        const epoch = store.deletionEpoch(input.topicKey);

        // 先落墓碑，再删摘要：即使在删除摘要期间进程崩溃，后续提交也不会把
        // 同一条被删消息的内容写回来。
        const tombstone = db.prepare(
          `INSERT INTO topic_deleted_messages (topic_key, message_id, deleted_at)
             VALUES (?, ?, ?)
           ON CONFLICT(topic_key, message_id) DO NOTHING`,
        );
        for (const messageId of deleted) tombstone.run(input.topicKey, messageId, input.now);

        const affected: string[] = [];
        for (const summary of readSummaryRows(input.topicKey)) {
          const sourceIds = parseJsonArray(summary.source_message_ids, isString);
          if (sourceIds.some(id => deleted.has(id))) affected.push(summary.summary_id);
        }
        for (const id of affected) {
          db.prepare('DELETE FROM topic_summary_embeddings WHERE summary_id = ?').run(id);
          db.prepare('DELETE FROM topic_summary_sources WHERE summary_id = ?').run(id);
          db.prepare('DELETE FROM topic_summaries WHERE summary_id = ? AND topic_key = ?').run(
            id,
            input.topicKey,
          );
        }
        if (affected.length === 0) {
          return { invalidated: 0, revision: Number(row.revision), epoch };
        }
        const nextRevision = Number(row.revision) + 1;
        db.prepare(
          'UPDATE topics SET revision = ?, updated_at = ? WHERE topic_key = ?',
        ).run(nextRevision, input.now, input.topicKey);
        return { invalidated: affected.length, revision: nextRevision, epoch };
      });
    },

    deletionEpoch(topicKey) {
      const row = db
        .prepare('SELECT epoch FROM topic_deletion_epochs WHERE topic_key = ?')
        .get(topicKey) as { epoch: number } | undefined;
      return row ? Number(row.epoch) : 0;
    },

    summariesReferencingSince(topicKey, sinceIso) {
      return (db.prepare(
        `SELECT s.summary_id, ss.message_id, ss.create_time
           FROM topic_summary_sources ss
           JOIN topic_summaries s ON s.summary_id = ss.summary_id
          WHERE s.topic_key = ? AND ss.create_time >= ?
          ORDER BY ss.create_time`,
      ).all(topicKey, sinceIso) as Array<{ summary_id: string; message_id: string; create_time: string }>)
        .map(row => ({ summaryId: row.summary_id, messageId: row.message_id, createTime: row.create_time }));
    },

    recordCheck(input) {
      db.prepare(
        `UPDATE topics
            SET last_checked_at = ?, coverage_start_at = COALESCE(coverage_start_at, ?), updated_at = ?
          WHERE topic_key = ?`,
      ).run(input.checkedAt, input.coverageStartAt ?? null, input.checkedAt, input.topicKey);
    },

    markSummaryEmbedding(input) {
      const summary = db
        .prepare('SELECT * FROM topic_summaries WHERE summary_id = ? AND topic_key = ?')
        .get(input.summaryId, input.topicKey) as SummaryRow | undefined;
      if (!summary) return false;
      // 迟到向量：正文已经不是这个 hash 了，丢弃（不覆盖、也不报错）。
      if (summaryContentHash(summary.text) !== input.contentHash) return false;
      db.prepare(
        `INSERT INTO topic_summary_embeddings (summary_id, model_key, content_hash, vector, updated_at)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(summary_id) DO UPDATE SET
           model_key = excluded.model_key,
           content_hash = excluded.content_hash,
           vector = excluded.vector,
           updated_at = excluded.updated_at`,
      ).run(input.summaryId, input.modelKey, input.contentHash, JSON.stringify(input.vector), input.now);
      return true;
    },

    pendingEmbeddingTasks(limit) {
      const rows = db
        .prepare(
          `SELECT s.summary_id, s.topic_key, s.text, e.content_hash
             FROM topic_summaries s
             LEFT JOIN topic_summary_embeddings e ON e.summary_id = s.summary_id
            ORDER BY s.topic_key, s.summary_id`,
        )
        .all() as Array<{ summary_id: string; topic_key: string; text: string; content_hash: string | null }>;
      const tasks: EmbeddingTask[] = [];
      for (const row of rows) {
        if (row.content_hash === summaryContentHash(row.text)) continue;
        tasks.push({ topicKey: row.topic_key, summaryId: row.summary_id, text: row.text });
        if (tasks.length >= Math.max(1, Math.floor(limit))) break;
      }
      return tasks;
    },

    jobState(topicKey) {
      const row = db.prepare('SELECT * FROM topic_jobs WHERE topic_key = ?').get(topicKey) as
        | {
            topic_key: string;
            attempts: number;
            next_attempt_at: string | null;
            error_code: string | null;
            last_outcome: string | null;
            updated_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        topicKey: row.topic_key,
        attempts: Number(row.attempts),
        ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
        updatedAt: row.updated_at,
      };
    },

    recordJobFailure(input) {
      const current = store.jobState(input.topicKey);
      db.prepare(
        `INSERT INTO topic_jobs (topic_key, attempts, next_attempt_at, error_code, last_outcome, updated_at)
           VALUES (?, ?, ?, ?, 'failed', ?)
         ON CONFLICT(topic_key) DO UPDATE SET
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           error_code = excluded.error_code,
           last_outcome = 'failed',
           updated_at = excluded.updated_at`,
      ).run(
        input.topicKey,
        (current?.attempts ?? 0) + 1,
        input.nextAttemptAt ?? null,
        input.errorCode,
        input.now,
      );
    },

    clearJobFailure(topicKey, now) {
      db.prepare(
        `INSERT INTO topic_jobs (topic_key, attempts, next_attempt_at, error_code, last_outcome, updated_at)
           VALUES (?, 0, NULL, NULL, 'ok', ?)
         ON CONFLICT(topic_key) DO UPDATE SET
           attempts = 0,
           next_attempt_at = NULL,
           error_code = NULL,
           last_outcome = 'ok',
           updated_at = excluded.updated_at`,
      ).run(topicKey, now);
    },

    acquireSlot(input) {
      return inTransaction(() => {
        const existing = db
          .prepare('SELECT * FROM topic_schedule_slots WHERE slot_id = ?')
          .get(input.slotId) as
          | { slot_id: string; owner: string; lease_expires_at: string; finished_at: string | null }
          | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO topic_schedule_slots (slot_id, owner, started_at, lease_expires_at, finished_at, status, error_code)
             VALUES (?, ?, ?, ?, NULL, 'running', NULL)`,
          ).run(
            input.slotId,
            input.owner,
            input.now,
            new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
          );
          return { acquired: true as const, mode: 'new' as const };
        }
        if (existing.finished_at) return { acquired: false as const, reason: 'already_finished' as const };
        if (existing.lease_expires_at > input.now) {
          return { acquired: false as const, reason: 'lease_held' as const };
        }
        // 租约过期 → 上一个 owner 大概率崩了：接管，并沿用同一 slot 记录。
        db.prepare(
          `UPDATE topic_schedule_slots
              SET owner = ?, started_at = ?, lease_expires_at = ?, status = 'running', error_code = NULL
            WHERE slot_id = ?`,
        ).run(
          input.owner,
          input.now,
          new Date(Date.parse(input.now) + input.leaseMs).toISOString(),
          input.slotId,
        );
        return { acquired: true as const, mode: 'taken_over' as const };
      });
    },

    finishSlot(input) {
      const result = db
        .prepare(
          `UPDATE topic_schedule_slots
              SET finished_at = ?, status = ?, error_code = ?
            WHERE slot_id = ? AND owner = ? AND finished_at IS NULL`,
        )
        .run(input.now, input.status, input.errorCode ?? null, input.slotId, input.owner);
      return Number(result.changes) > 0;
    },

    pruneSlots(before) {
      const result = db
        .prepare('DELETE FROM topic_schedule_slots WHERE started_at < ? AND finished_at IS NOT NULL')
        .run(before);
      return Number(result.changes);
    },

    getNextRunAt() {
      const row = db
        .prepare("SELECT next_run_at FROM topic_schedule_state WHERE state_key = 'default'")
        .get() as { next_run_at: string | null } | undefined;
      return row?.next_run_at ?? null;
    },

    setNextRunAt(nextRunAt, now) {
      db.prepare(
        `INSERT INTO topic_schedule_state (state_key, next_run_at, updated_at)
           VALUES ('default', ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
           next_run_at = excluded.next_run_at,
           updated_at = excluded.updated_at`,
      ).run(nextRunAt, now);
    },

    deleteTopic(topicKey) {
      inTransaction(() => {
        const ids = (
          db.prepare('SELECT summary_id FROM topic_summaries WHERE topic_key = ?').all(topicKey) as Array<{
            summary_id: string;
          }>
        ).map(row => row.summary_id);
        for (const id of ids) {
          db.prepare('DELETE FROM topic_summary_embeddings WHERE summary_id = ?').run(id);
          db.prepare('DELETE FROM topic_summary_sources WHERE summary_id = ?').run(id);
        }
        db.prepare('DELETE FROM topic_summaries WHERE topic_key = ?').run(topicKey);
        db.prepare('DELETE FROM topics WHERE topic_key = ?').run(topicKey);
        db.prepare('DELETE FROM topic_jobs WHERE topic_key = ?').run(topicKey);
        db.prepare('DELETE FROM topic_deleted_messages WHERE topic_key = ?').run(topicKey);
        db.prepare('DELETE FROM topic_deletion_epochs WHERE topic_key = ?').run(topicKey);
      });
    },

    close() {
      try {
        db.close();
      } catch {
        // 已经关掉了：幂等。
      }
    },
  };

  return store;
}
