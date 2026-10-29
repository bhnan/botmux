/**
 * 单话题的增量摘要更新（P4 的核心）。
 *
 * 这里是「游标推进」唯一发生的地方，因此规则写死在这儿：
 * - **没有增量就不调模型**，只更新检查时间；
 * - 模型输出校验失败、提交冲突、embedding 失败都**不推进游标**（embedding 不回滚已提交的摘要）；
 * - 提交按 revision CAS：冲突时重新读取，把已失效的 update 丢掉（降级成 noop），
 *   再提交一次；仍冲突就放弃本轮，让下一轮再来 —— 绝不覆盖别人刚写的结果。
 */

import type { Topic } from '../types.js';
import { threadTopicKey } from './identity.js';
import type { EnrichmentRequest, SummaryMutation, TopicEnricher } from './model-client.js';
import {
  decodeCursor,
  encodeCursor,
  normalizeSourceMessages,
  renderMessageForPrompt,
  selectIncrement,
  type TopicDirectoryEntry,
  type TopicHistoryReader,
} from './source.js';
import type { TopicStore } from './store.js';
import { summaryContentHash } from './vector.js';

export interface SummaryUpdateLimits {
  maxSummaryChars: number;
  maxKeywordsPerSummary: number;
  maxMessagesPerBatch: number;
  /** 送进模型的旧摘要条数上限（只挑最近的相关摘要，不重发全量历史）。 */
  maxExistingSummaries: number;
  /** 消息进 prompt 后的单条字符上限。 */
  maxMessageChars: number;
}

export const SUMMARY_UPDATE_DEFAULT_LIMITS: SummaryUpdateLimits = {
  maxSummaryChars: 600,
  maxKeywordsPerSummary: 8,
  maxMessagesPerBatch: 40,
  maxExistingSummaries: 20,
  maxMessageChars: 2_000,
};

export type UpdateTopicStatus = 'no_increment' | 'committed' | 'conflict' | 'failed' | 'skipped';

export interface UpdateTopicOutcome {
  topicKey: string;
  status: UpdateTopicStatus;
  batchSize: number;
  added: number;
  updated: number;
  cursorAdvanced: boolean;
  errorCode?: string;
}

export interface UpdateTopicDeps {
  store: TopicStore;
  source: TopicHistoryReader;
  enricher: TopicEnricher;
  limits?: Partial<SummaryUpdateLimits>;
  now?: () => string;
}

export interface TopicUpdateOptions {
  /** 该话题的失败退避时刻；未到点则跳过（避免每轮都撞同一个坏话题）。 */
  skipUntil?: (topicKey: string) => boolean;
}

function limitsOf(deps: UpdateTopicDeps): SummaryUpdateLimits {
  return { ...SUMMARY_UPDATE_DEFAULT_LIMITS, ...deps.limits };
}

/** 失败退避：指数增长，上限 6 小时（后台任务不能无限重试烧钱）。 */
export function computeRetryAtIso(attempts: number, nowIso: string): string {
  const backoffMs = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
  return new Date(Date.parse(nowIso) + backoffMs).toISOString();
}

function countMutations(mutations: readonly SummaryMutation[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const mutation of mutations) {
    if (mutation.op === 'add') added += 1;
    if (mutation.op === 'update') updated += 1;
  }
  return { added, updated };
}

/**
 * 冲突重试时把 update 降级：目标摘要正文已被别处改写 → 这条 update 的语义前提没了，
 * 直接丢弃（等价 noop），而不是拿旧前提覆盖新正文。
 */
function reconcileMutationsAfterConflict(
  mutations: readonly SummaryMutation[],
  before: Topic,
  after: Topic,
): SummaryMutation[] {
  const beforeText = new Map(before.summaries.map(summary => [summary.id, summary.text]));
  const afterIds = new Set(after.summaries.map(summary => summary.id));
  const reconciled: SummaryMutation[] = [];
  for (const mutation of mutations) {
    if (mutation.op === 'noop') continue;
    if (mutation.op === 'add') {
      reconciled.push(mutation);
      continue;
    }
    if (!afterIds.has(mutation.id)) continue;
    const original = beforeText.get(mutation.id);
    const current = after.summaries.find(summary => summary.id === mutation.id)?.text;
    if (original === undefined || current !== original) continue;
    reconciled.push(mutation);
  }
  return reconciled.length > 0 ? reconciled : [{ op: 'noop' }];
}

function buildRequest(
  topic: Topic,
  messages: ReadonlyArray<{ messageId: string; createTime: string; text: string; senderName?: string }>,
  limits: SummaryUpdateLimits,
): EnrichmentRequest {
  const existingSummaries = topic.summaries
    .slice(-limits.maxExistingSummaries)
    .map(summary => ({
      id: summary.id,
      text: summary.text,
      keywords: summary.keywords,
      sourceMessageIds: summary.sourceMessageIds,
    }));
  return {
    topicTitle: topic.title,
    existingSummaries,
    newMessages: messages.map(message => ({
      messageId: message.messageId,
      createTime: message.createTime,
      text: renderMessageForPrompt(
        { messageId: message.messageId, createTime: message.createTime, text: message.text },
        limits.maxMessageChars,
      ),
      ...(message.senderName ? { senderName: message.senderName } : {}),
    })),
    maxSummaryChars: limits.maxSummaryChars,
    maxKeywordsPerSummary: limits.maxKeywordsPerSummary,
  };
}

export async function updateTopicFromSource(
  deps: UpdateTopicDeps,
  entry: TopicDirectoryEntry,
  options: TopicUpdateOptions = {},
): Promise<UpdateTopicOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const limits = limitsOf(deps);
  const topicKey = threadTopicKey(entry.chatId, entry.rootMessageId);

  if (options.skipUntil?.(topicKey)) {
    return { topicKey, status: 'skipped', batchSize: 0, added: 0, updated: 0, cursorAdvanced: false };
  }

  deps.store.upsertTopicDirectory({
    topicKey,
    chatId: entry.chatId,
    rootMessageId: entry.rootMessageId,
    ...(entry.nativeThreadId ? { nativeThreadId: entry.nativeThreadId } : {}),
    title: entry.title,
    accessPolicyRef: entry.accessPolicyRef,
    now: now(),
    coverageStartAt: now(),
  });

  const topic = deps.store.getTopic(topicKey);
  if (!topic) {
    return { topicKey, status: 'failed', batchSize: 0, added: 0, updated: 0, cursorAdvanced: false, errorCode: 'topic_missing' };
  }

  const cursor = decodeCursor(topic.summarizedThroughCursor) ?? undefined;
  let page;
  try {
    page = await deps.source.readMessages(entry, {
      ...(cursor ? { after: cursor } : {}),
      limit: limits.maxMessagesPerBatch,
    });
  } catch {
    const checkedAt = now();
    deps.store.recordJobFailure({
      topicKey,
      errorCode: 'source_read_failed',
      nextAttemptAt: computeRetryAtIso((deps.store.jobState(topicKey)?.attempts ?? 0) + 1, checkedAt),
      now: checkedAt,
    });
    return {
      topicKey,
      status: 'failed',
      batchSize: 0,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
      errorCode: 'source_read_failed',
    };
  }

  if (page.truncated) {
    // 源侧窗口没覆盖到游标：本轮**不摘要**（否则游标会跨过读不到的中间段）。
    // 记成可重试失败，让运维看到 `source_window_too_narrow`，而不是静默丢消息。
    const checkedAt = now();
    deps.store.recordJobFailure({
      topicKey,
      errorCode: 'source_window_too_narrow',
      nextAttemptAt: computeRetryAtIso((deps.store.jobState(topicKey)?.attempts ?? 0) + 1, checkedAt),
      now: checkedAt,
    });
    return {
      topicKey,
      status: 'failed',
      batchSize: 0,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
      errorCode: 'source_window_too_narrow',
    };
  }

  const normalized = normalizeSourceMessages(page.messages);
  const selection = selectIncrement({ messages: normalized, cursor, limit: limits.maxMessagesPerBatch });
  const checkedAt = now();

  if (selection.batch.length === 0) {
    // 零增量：只记检查状态，零模型调用。
    deps.store.recordCheck({ topicKey, checkedAt });
    deps.store.clearJobFailure(topicKey, checkedAt);
    return {
      topicKey,
      status: 'no_increment',
      batchSize: 0,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
    };
  }

  // 已删除的消息不进摘要；但整批都是删除时仍要推进游标（否则会被永久重读）。
  const live = selection.batch.filter(message => message.deleted !== true);
  const nextCursor = selection.nextCursor ? encodeCursor(selection.nextCursor) : topic.summarizedThroughCursor ?? '';

  if (live.length === 0) {
    const result = deps.store.commitSummaryMutation({
      topicKey,
      expectedRevision: topic.revision,
      mutations: [{ op: 'noop' }],
      nextCursor,
      sourceThroughAt: checkedAt,
      generatorKey: deps.enricher.generatorKey,
      now: checkedAt,
    });
    const advanced = result.status === 'committed';
    if (advanced) deps.store.clearJobFailure(topicKey, checkedAt);
    return {
      topicKey,
      status: advanced ? 'committed' : 'conflict',
      batchSize: selection.batch.length,
      added: 0,
      updated: 0,
      cursorAdvanced: advanced,
    };
  }

  let mutations: SummaryMutation[];
  try {
    const enrichment = await deps.enricher.enrich(buildRequest(topic, live, limits));
    mutations = enrichment.mutations;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'enrich_failed';
    deps.store.recordJobFailure({
      topicKey,
      errorCode: code,
      nextAttemptAt: computeRetryAtIso((deps.store.jobState(topicKey)?.attempts ?? 0) + 1, checkedAt),
      now: checkedAt,
    });
    return {
      topicKey,
      status: 'failed',
      batchSize: selection.batch.length,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
      errorCode: code,
    };
  }

  const commit = deps.store.commitSummaryMutation({
    topicKey,
    expectedRevision: topic.revision,
    mutations,
    nextCursor,
    sourceThroughAt: checkedAt,
    generatorKey: deps.enricher.generatorKey,
    now: checkedAt,
  });

  if (commit.status === 'committed') {
    deps.store.clearJobFailure(topicKey, checkedAt);
    const counts = countMutations(mutations);
    return {
      topicKey,
      status: 'committed',
      batchSize: selection.batch.length,
      added: counts.added,
      updated: counts.updated,
      cursorAdvanced: true,
    };
  }

  if (commit.status === 'conflict') {
    // 冲突重读：把语义前提已变的 update 丢掉，再提交一次；不重跑模型（模型结果仍有效）。
    const fresh = deps.store.getTopic(topicKey);
    if (!fresh) {
      return { topicKey, status: 'conflict', batchSize: selection.batch.length, added: 0, updated: 0, cursorAdvanced: false };
    }
    const reconciled = reconcileMutationsAfterConflict(mutations, topic, fresh);
    const retried = deps.store.commitSummaryMutation({
      topicKey,
      expectedRevision: fresh.revision,
      mutations: reconciled,
      nextCursor,
      sourceThroughAt: checkedAt,
      generatorKey: deps.enricher.generatorKey,
      now: checkedAt,
    });
    if (retried.status === 'committed') {
      deps.store.clearJobFailure(topicKey, checkedAt);
      const counts = countMutations(reconciled);
      return {
        topicKey,
        status: 'committed',
        batchSize: selection.batch.length,
        added: counts.added,
        updated: counts.updated,
        cursorAdvanced: true,
      };
    }
    return {
      topicKey,
      status: 'conflict',
      batchSize: selection.batch.length,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
      errorCode: 'revision_conflict',
    };
  }

  return {
    topicKey,
    status: 'failed',
    batchSize: selection.batch.length,
    added: 0,
    updated: 0,
    cursorAdvanced: false,
    errorCode: 'topic_missing',
  };
}

export interface EmbeddingBackfillResult {
  attempted: number;
  stored: number;
  failed: number;
  errorCode?: string;
}

/**
 * 向量回填：只处理「正文变了/还没有向量」的摘要。摘要已提交成功时这里的失败**不回滚**
 * 摘要、也不重新调 LLM，任务留在表里下一轮再试。
 */
export async function runEmbeddingBackfill(input: {
  store: TopicStore;
  embedder: { modelKey: string; embed: (text: string) => Promise<number[]> };
  now?: () => string;
  limit?: number;
}): Promise<EmbeddingBackfillResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const tasks = input.store.pendingEmbeddingTasks(input.limit ?? 20);
  let stored = 0;
  let failed = 0;
  let errorCode: string | undefined;
  for (const task of tasks) {
    try {
      const vector = await input.embedder.embed(task.text);
      const ok = input.store.markSummaryEmbedding({
        topicKey: task.topicKey,
        summaryId: task.summaryId,
        modelKey: input.embedder.modelKey,
        contentHash: summaryContentHash(task.text),
        vector,
        now: now(),
      });
      if (ok) stored += 1;
    } catch (error) {
      failed += 1;
      errorCode = (error as { code?: string } | null)?.code ?? 'embedding_failed';
    }
  }
  return { attempted: tasks.length, stored, failed, ...(errorCode ? { errorCode } : {}) };
}
