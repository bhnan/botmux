/** Per-topic incremental summary update (spec §5.2 steps 4–8).
 *
 * One topic pass: slice the increment off the read window → optionally
 * invalidate summaries whose cited messages vanished → ONE structured model
 * call over the bounded batch + relevant old summaries → revision-CAS commit
 * of summaries/keywords/cursor/embedding jobs.
 *
 * Failure invariants (spec §5.4):
 * - model failure / validation failure / CAS give-up ⇒ cursor untouched;
 * - a successful read with no increment ⇒ lastCheckedAt only, zero model
 *   calls (recorded by the runtime, not here);
 - deletion invalidation does NOT move the cursor (the messages WERE
 *   processed; removal is about knowledge, not progress).
 */
import type { Topic } from '../types.js';
import type { TopicModelCallInput, TopicModelCallResult, TopicModelMessage } from './model-client.js';
import { TopicRevisionConflictError, type TopicStore } from './store.js';
import { dedupeSourceMessages, findVanishedSourceRefs, sliceIncrement, type TopicHistoryWindow } from './source.js';

/** How many recent summaries form the "relevant old summaries" context
 * window (spec §5.3: 只选择相关旧摘要和有限窗口). */
export const OLD_SUMMARY_CONTEXT_LIMIT = 10;
export const MAX_BATCH_MESSAGES = 120;

export type TopicUpdateOutcome =
  | { kind: 'no_increment'; skippedReason?: 'cursor_beyond_window' }
  | { kind: 'committed'; revision: number; added: number; updated: number; noop: boolean }
  | { kind: 'invalidated'; removedSummaryIds: string[] }
  | { kind: 'model_failed'; code: string }
  | { kind: 'commit_conflict' };

export interface TopicUpdateDeps {
  store: TopicStore;
  /** Injectable model call (tests). Defaults to callSummaryModel with the
   * given profile — the runtime injects a config-bound wrapper. */
  callModel: (input: TopicModelCallInput) => Promise<TopicModelCallResult>;
  now: () => string;
}

export interface TopicUpdateOptions {
  embeddingModelKey?: string;
  /** First-run lookback boundary (epoch ms). */
  firstRunSinceMs?: number;
}

function relevantOldSummaries(topic: Topic): Array<{ id: string; text: string; keywords: string[]; sourceMessageIds: string[] }> {
  return topic.summaries
    .slice(-OLD_SUMMARY_CONTEXT_LIMIT)
    .map(s => ({ id: s.id, text: s.text, keywords: s.keywords, sourceMessageIds: s.sourceMessageIds }));
}

function toModelMessages(batch: ReadonlyArray<{ messageId: string; senderName?: string; createTimeMs?: number; text: string }>): TopicModelMessage[] {
  return batch.map(m => ({
    messageId: m.messageId,
    ...(m.senderName ? { senderName: m.senderName } : {}),
    ...(m.createTimeMs !== undefined ? { createTime: new Date(m.createTimeMs).toISOString() } : {}),
    text: m.text,
  }));
}

/** Process one topic's window. Never throws for per-topic failures — returns
 * a machine outcome so the runtime can continue other topics and persist a
 * sanitized job error. */
export async function updateTopicFromWindow(
  deps: TopicUpdateDeps,
  args: { topicKey: string; window: TopicHistoryWindow },
  options: TopicUpdateOptions = {},
): Promise<TopicUpdateOutcome> {
  const topic = deps.store.getTopic(args.topicKey);
  if (!topic) return { kind: 'model_failed', code: 'topic_missing' };

  // SOURCE time observation is independent of summarization: even when the
  // model call below fails, latestMessageAt must reflect messages this read
  // already observed (change.md §3 验收例：3 日新消息摘要失败仍按 3 日命中)。
  const timedMessages = dedupeSourceMessages(args.window.messages)
    .filter(m => m.createTimeMs !== undefined)
    .map(m => m.createTimeMs!);
  if (timedMessages.length > 0) {
    try {
      deps.store.observeTopicTimes(args.topicKey, {
        earliestObservedAt: new Date(Math.min(...timedMessages)).toISOString(),
        latestObservedAt: new Date(Math.max(...timedMessages)).toISOString(),
      }, deps.now());
    } catch { /* topic vanished concurrently; observation is best-effort */ }
  }

  const sliced = sliceIncrement(args.window.messages, {
    cursor: topic.summarizedThroughCursor,
    firstRunSinceMs: options.firstRunSinceMs,
    maxBatchMessages: MAX_BATCH_MESSAGES,
    sourceThroughAtMs: topic.sourceThroughAt ? Date.parse(topic.sourceThroughAt) : undefined,
  });

  // Deletion-driven invalidation over the observable window (independent of
  // whether there is an increment — a deleted cited message must not keep
  // leaking from search).
  if (!args.window.truncated && topic.summaries.length > 0) {
    const bySummary = new Map<string, readonly string[]>();
    for (const s of topic.summaries) bySummary.set(s.id, s.sourceMessageIds);
    const allCited = [...bySummary.values()].flat();
    const vanished = findVanishedSourceRefs(args.window, allCited);
    if (vanished.length > 0) {
      const vanishedSet = new Set(vanished);
      const doomed = topic.summaries
        .filter(s => s.sourceMessageIds.some(id => vanishedSet.has(id)))
        .map(s => s.id);
      if (doomed.length > 0) {
        const removed = deps.store.invalidateSummaries(args.topicKey, doomed, deps.now());
        if (removed.length > 0) return { kind: 'invalidated', removedSummaryIds: removed };
      }
    }
  }

  if (!sliced.hasIncrement) return { kind: 'no_increment', skippedReason: sliced.skippedReason };

  const refreshed = deps.store.getTopic(args.topicKey) ?? topic;
  let modelResult = await deps.callModel({
    topicTitle: refreshed.title,
    oldSummaries: relevantOldSummaries(refreshed),
    newMessages: toModelMessages(sliced.batch),
  });
  if (!modelResult.ok) return { kind: 'model_failed', code: modelResult.code };

  const current = deps.store.getTopic(args.topicKey);
  if (!current) return { kind: 'model_failed', code: 'topic_missing' };
  try {
    const committed = deps.store.commitSummaryUpdate({
      topicKey: args.topicKey,
      expectedRevision: current.revision,
      mutations: modelResult.mutations,
      generatorKey: modelResult.generatorKey,
      now: deps.now(),
      summarizedThroughCursor: sliced.batchEndCursor,
      sourceThroughAt: sliced.batch[sliced.batch.length - 1].createTimeMs !== undefined
        ? new Date(sliced.batch[sliced.batch.length - 1].createTimeMs!).toISOString()
        : current.sourceThroughAt,
      ...(sliced.batchCoverageStartAt && !current.coverageStartAt ? { coverageStartAt: sliced.batchCoverageStartAt } : {}),
      ...(options.embeddingModelKey ? { embeddingModelKey: options.embeddingModelKey } : {}),
    });
    return {
      kind: 'committed',
      revision: committed.revision,
      added: modelResult.mutations.filter(m => m.op === 'add').length,
      updated: modelResult.mutations.filter(m => m.op === 'update').length,
      noop: modelResult.mutations.every(m => m.op === 'noop'),
    };
  } catch (error) {
    if (!(error instanceof TopicRevisionConflictError)) throw error;
    // A concurrent writer (another instance after lease expiry, or deletion
    // invalidation) advanced the topic. NEVER replay the same mutations: they
    // were generated for a state that no longer exists — replaying an add-only
    // batch duplicates rows, and committing our stale batchEndCursor can move
    // the cursor BACKWARDS past work the winner already did (spec §5.5 重试
    // 不能重复添加已提交条目). Give up this round; the retry path re-slices
    // from the winner's cursor with a fresh model call.
    return { kind: 'commit_conflict' };
  }
}
