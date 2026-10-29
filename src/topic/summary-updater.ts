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
  /** 删除核查窗口：向游标之前重叠多久（只读消息 id，不送模型、不动游标）。 */
  recheckOverlapMs: number;
  /** 核查窗口单次最多读多少条；被预算截断时放弃「缺失即删除」判断。 */
  recheckLimit: number;
}

export const SUMMARY_UPDATE_DEFAULT_LIMITS: SummaryUpdateLimits = {
  maxSummaryChars: 600,
  maxKeywordsPerSummary: 8,
  maxMessagesPerBatch: 40,
  maxExistingSummaries: 20,
  maxMessageChars: 2_000,
  recheckOverlapMs: 24 * 60 * 60_000,
  recheckLimit: 200,
};

export type UpdateTopicStatus = 'no_increment' | 'committed' | 'conflict' | 'failed' | 'skipped';

export interface UpdateTopicOutcome {
  topicKey: string;
  status: UpdateTopicStatus;
  batchSize: number;
  added: number;
  updated: number;
  cursorAdvanced: boolean;
  /** 本轮因源侧确认删除而失效的摘要条数。 */
  invalidated?: number;
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
  // 删除核查必须看到「已摘要」的消息，而增量读取只返回游标之后。因此有游标时
  // 把读取边界向过去重叠一段：重叠段只用于判断哪些旧消息消失了，不送模型
  // （selectIncrement 仍按原游标切增量），也不会把游标往回写。
  const overlapMs = Math.max(0, limits.recheckOverlapMs);
  let recheckSinceIso: string | undefined;
  let readAfter: typeof cursor;
  if (cursor && overlapMs > 0) {
    const cursorMs = Date.parse(cursor.createTime);
    if (Number.isFinite(cursorMs)) {
      recheckSinceIso = new Date(cursorMs - overlapMs).toISOString();
      readAfter = { createTime: recheckSinceIso, messageIds: [] };
    }
  }
  readAfter ??= cursor;

  const readPage = (after: typeof cursor, limit: number) =>
    deps.source.readMessages(entry, {
      ...(after ? { after } : {}),
      limit,
    });

  let page;
  // 截断的重叠页里已经明确标了 deleted 的消息不能因为退回增量而丢掉。
  let earlyDeletedIds: string[] = [];
  try {
    page = await readPage(readAfter, recheckSinceIso ? limits.recheckLimit : limits.maxMessagesPerBatch);
    if (page.truncated && recheckSinceIso) {
      // 重叠窗口太宽（话题消息量超过核查预算）：先把本页显式删除标记记下，
      // 再退回正常增量；本轮放弃「缺席即删除」，但增量摘要照常推进——
      // 不能因为核查读不完就把话题卡死。
      earlyDeletedIds = normalizeSourceMessages(page.messages)
        .filter(message => message.deleted === true)
        .map(message => message.messageId);
      recheckSinceIso = undefined;
      page = await readPage(cursor, limits.maxMessagesPerBatch);
    }
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

  const normalized = normalizeSourceMessages(page.messages);
  const checkedAt = now();
  const sourceMessageTimes: Record<string, string> = {};
  for (const message of normalized) sourceMessageTimes[message.messageId] = message.createTime;

  let currentTopic = topic;
  let invalidated = 0;
  const invalidate = (messageIds: Iterable<string>): void => {
    const ids = [...new Set(messageIds)].filter(Boolean);
    if (ids.length === 0) return;
    const result = deps.store.invalidateSummariesForMessages({ topicKey, messageIds: ids, now: checkedAt });
    invalidated += result.invalidated;
    if (result.invalidated > 0) currentTopic = deps.store.getTopic(topicKey) ?? currentTopic;
  };

  if (page.truncated) {
    // 窗口没覆盖到游标：本轮不摘要，但窗口里明确标了 deleted 的消息仍要立即失效。
    invalidate([
      ...earlyDeletedIds,
      ...normalized.filter(message => message.deleted === true).map(message => message.messageId),
    ]);
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
      ...(invalidated > 0 ? { invalidated } : {}),
      errorCode: 'source_window_too_narrow',
    };
  }

  if (page.nativeThreadId) {
    // 原生话题 id 只用于跳转，但需要在读到它的这一轮落库，否则页面拿不到入口。
    deps.store.upsertTopicDirectory({
      topicKey,
      chatId: entry.chatId,
      rootMessageId: entry.rootMessageId,
      nativeThreadId: page.nativeThreadId,
      title: entry.title,
      accessPolicyRef: entry.accessPolicyRef,
      now: checkedAt,
    });
  }

  const selection = selectIncrement({ messages: normalized, cursor, limit: limits.maxMessagesPerBatch });

  // 删除检测的两种来源：
  // 1. 源侧在本次读到的任意消息上标了 deleted（不只增量段）；
  // 2. 重叠窗口内、之前已摘要过的来源消息在完整窗口里消失 —— 只有页面完整
  //    （truncated=false）时才敢把「缺席」当删除，否则会把读不到的旧消息误删。
  const deletedIds = new Set<string>(earlyDeletedIds);
  for (const message of normalized) {
    if (message.deleted === true) deletedIds.add(message.messageId);
  }
  // 退化成按 root_id 扫群时，话题回复本来就可能读不到；此时「缺席」不代表删除。
  if (cursor && recheckSinceIso && page.verifiedThread === true) {
    const present = new Set(
      normalized
        .filter(message => message.createTime >= recheckSinceIso!)
        .map(message => message.messageId),
    );
    for (const ref of deps.store.summariesReferencingSince(topicKey, recheckSinceIso)) {
      if (ref.createTime > cursor.createTime) continue;
      if (!present.has(ref.messageId)) deletedIds.add(ref.messageId);
    }
  }
  invalidate(deletedIds);

  const deletionEpoch = deps.store.deletionEpoch(topicKey);

  const failAfterCommitError = (errorCode: string, batchSize: number): UpdateTopicOutcome => {
    const at = now();
    deps.store.recordJobFailure({
      topicKey,
      errorCode,
      nextAttemptAt: computeRetryAtIso((deps.store.jobState(topicKey)?.attempts ?? 0) + 1, at),
      now: at,
    });
    return {
      topicKey,
      status: 'failed',
      batchSize,
      added: 0,
      updated: 0,
      cursorAdvanced: false,
      ...(invalidated > 0 ? { invalidated } : {}),
      errorCode,
    };
  };

  const commit = (input: Parameters<TopicStore['commitSummaryMutation']>[0]) => {
    try {
      return deps.store.commitSummaryMutation(input);
    } catch {
      return null;
    }
  };

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
      ...(invalidated > 0 ? { invalidated } : {}),
    };
  }

  // 已删除的消息不进摘要；但整批都是删除时仍要推进游标（否则会被永久重读）。
  const live = selection.batch.filter(message => message.deleted !== true);
  const nextCursor = selection.nextCursor ? encodeCursor(selection.nextCursor) : currentTopic.summarizedThroughCursor ?? '';

  if (live.length === 0) {
    const result = commit({
      topicKey,
      expectedRevision: currentTopic.revision,
      expectedDeletionEpoch: deletionEpoch,
      mutations: [{ op: 'noop' }],
      sourceMessageTimes,
      nextCursor,
      sourceThroughAt: checkedAt,
      generatorKey: deps.enricher.generatorKey,
      now: checkedAt,
    });
    if (!result) return failAfterCommitError('commit_failed', selection.batch.length);
    if (result.status === 'blocked') return failAfterCommitError(result.reason, selection.batch.length);
    const advanced = result.status === 'committed';
    if (advanced) deps.store.clearJobFailure(topicKey, checkedAt);
    return {
      topicKey,
      status: advanced ? 'committed' : 'conflict',
      batchSize: selection.batch.length,
      added: 0,
      updated: 0,
      cursorAdvanced: advanced,
      ...(invalidated > 0 ? { invalidated } : {}),
    };
  }

  let mutations: SummaryMutation[];
  try {
    const enrichment = await deps.enricher.enrich(buildRequest(currentTopic, live, limits));
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
      ...(invalidated > 0 ? { invalidated } : {}),
      errorCode: code,
    };
  }

  const result = commit({
    topicKey,
    expectedRevision: currentTopic.revision,
    expectedDeletionEpoch: deletionEpoch,
    mutations,
    sourceMessageTimes,
    nextCursor,
    sourceThroughAt: checkedAt,
    generatorKey: deps.enricher.generatorKey,
    now: checkedAt,
  });
  if (!result) return failAfterCommitError('commit_failed', selection.batch.length);
  if (result.status === 'blocked') return failAfterCommitError(result.reason, selection.batch.length);

  if (result.status === 'committed') {
    deps.store.clearJobFailure(topicKey, checkedAt);
    return {
      topicKey,
      status: 'committed',
      batchSize: selection.batch.length,
      added: result.applied.added,
      updated: result.applied.updated,
      cursorAdvanced: true,
      ...(invalidated > 0 ? { invalidated } : {}),
    };
  }

  if (result.status === 'conflict') {
    // 冲突重读：把语义前提已变的 update 丢掉，再提交一次；不重跑模型（模型结果仍有效）。
    const fresh = deps.store.getTopic(topicKey);
    if (!fresh) {
      return { topicKey, status: 'conflict', batchSize: selection.batch.length, added: 0, updated: 0, cursorAdvanced: false };
    }
    const reconciled = reconcileMutationsAfterConflict(mutations, currentTopic, fresh);
    const retried = commit({
      topicKey,
      expectedRevision: fresh.revision,
      // 必须沿用 enrich 前捕获的 epoch：若期间发生过失效，revision 冲突会让重试
      // 读到新 epoch，从而把基于旧快照的结果放进来。
      expectedDeletionEpoch: deletionEpoch,
      mutations: reconciled,
      sourceMessageTimes,
      nextCursor,
      sourceThroughAt: checkedAt,
      generatorKey: deps.enricher.generatorKey,
      now: checkedAt,
    });
    if (!retried) return failAfterCommitError('commit_failed', selection.batch.length);
    if (retried.status === 'blocked') return failAfterCommitError(retried.reason, selection.batch.length);
    if (retried.status === 'committed') {
      deps.store.clearJobFailure(topicKey, checkedAt);
      return {
        topicKey,
        status: 'committed',
        batchSize: selection.batch.length,
        added: retried.applied.added,
        updated: retried.applied.updated,
        cursorAdvanced: true,
        ...(invalidated > 0 ? { invalidated } : {}),
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

  return { topicKey, status: 'failed', batchSize: 0, added: 0, updated: 0, cursorAdvanced: false, errorCode: 'topic_missing' };
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
