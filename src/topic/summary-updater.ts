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
import { dedupeSourceMessages, decodeSourceCursor, findVanishedSourceRefs, sliceIncrement, type SourceMessage, type TopicHistoryWindow } from './source.js';

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
  // already observed (change.md §3 验收例：3 日新消息摘要失败仍按 3 日命中）。
  // topicCreatedAt 只接受被证实的根消息时间；截断窗口的最早回复不是根时间，
  // 缺失时保持 unknown（change.md 复测问题 3）。
  const timedMessages = dedupeSourceMessages(args.window.messages)
    .filter(m => m.createTimeMs !== undefined)
    .map(m => m.createTimeMs!);
  if (timedMessages.length > 0 || args.window.rootCreatedAtMs !== undefined) {
    try {
      deps.store.observeTopicTimes(args.topicKey, {
        ...(args.window.rootCreatedAtMs !== undefined
          ? { earliestObservedAt: new Date(args.window.rootCreatedAtMs).toISOString() }
          : {}),
        ...(timedMessages.length > 0
          ? { latestObservedAt: new Date(Math.max(...timedMessages)).toISOString() }
          : {}),
      }, deps.now());
    } catch { /* topic vanished concurrently; observation is best-effort */ }
  }

  let sliced = sliceIncrement(args.window.messages, {
    cursor: topic.summarizedThroughCursor,
    firstRunSinceMs: options.firstRunSinceMs,
    maxBatchMessages: MAX_BATCH_MESSAGES,
    cursorFound: args.window.cursorFound,
  });

  // Deletion-driven invalidation requires INDEPENDENT full-coverage evidence
  // (reachedOldest): an after-cursor increment window — even a continuous,
  // cursor-proven one — is not the full history, and treating it as such
  // would delete every summary citing pre-cursor messages (复测第二轮问题 2).
  if (args.window.reachedOldest === true && topic.summaries.length > 0) {
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

  // Snapshot BEFORE the model call: the mutations will be validated against
  // and committed with THIS revision. A writer that commits while we wait on
  // the model therefore forces a conflict below — its own cursor and rows
  // can never be overwritten by our stale batch (change.md 复测问题 1).
  let snapshot = deps.store.getTopic(args.topicKey);
  if (!snapshot) return { kind: 'model_failed', code: 'topic_missing' };
  let modelResult = await deps.callModel({
    topicTitle: snapshot.title,
    oldSummaries: relevantOldSummaries(snapshot),
    newMessages: toModelMessages(sliced.batch),
  });
  if (!modelResult.ok) return { kind: 'model_failed', code: modelResult.code };

  for (let attempt = 0; ; attempt++) {
    try {
      const committed = deps.store.commitSummaryUpdate({
        topicKey: args.topicKey,
        expectedRevision: snapshot.revision,
        mutations: modelResult.mutations,
        generatorKey: modelResult.generatorKey,
        now: deps.now(),
        summarizedThroughCursor: sliced.batchEndCursor,
        sourceThroughAt: sliced.batch[sliced.batch.length - 1].createTimeMs !== undefined
          ? new Date(sliced.batch[sliced.batch.length - 1].createTimeMs!).toISOString()
          : snapshot.sourceThroughAt,
        ...(sliced.batchCoverageStartAt && !snapshot.coverageStartAt ? { coverageStartAt: sliced.batchCoverageStartAt } : {}),
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
      if (attempt >= 1) return { kind: 'commit_conflict' };
      // Lost the race. NEVER commit the stale mutations under a fresh
      // revision. Compute what is PROVABLY still pending relative to the
      // winner's cursor: only messages positioned after that cursor inside
      // our (already continuity-checked) window. A cursor we cannot locate in
      // the window means nothing provably pending — the next round's reader
      // scans back to the winner's cursor and processes the real remainder.
      const winner = deps.store.getTopic(args.topicKey);
      if (!winner) return { kind: 'model_failed', code: 'topic_missing' };
      const windowMessages = dedupeSourceMessages(args.window.messages);
      let pending: SourceMessage[];
      const winnerCursorId = winner.summarizedThroughCursor ? decodeSourceCursor(winner.summarizedThroughCursor) : '';
      if (!winnerCursorId) {
        pending = windowMessages; // winner committed nothing cursor-wise
      } else {
        const winnerIndex = windowMessages.findIndex(m => m.messageId === winnerCursorId);
        pending = winnerIndex >= 0 ? windowMessages.slice(winnerIndex + 1) : [];
      }
      if (pending.length === 0) {
        return { kind: 'no_increment' };
      }
      sliced = sliceIncrement(pending, { maxBatchMessages: MAX_BATCH_MESSAGES });
      const regenerated = await deps.callModel({
        topicTitle: winner.title,
        oldSummaries: relevantOldSummaries(winner),
        newMessages: toModelMessages(sliced.batch),
      });
      if (!regenerated.ok) return { kind: 'model_failed', code: regenerated.code };
      // Bind the regenerated commit to the state its INPUT came from (the
      // winner snapshot) — NOT a post-model re-read. A writer that commits
      // during THIS model wait must force the next conflict (and the loop
      // exits on it) instead of lending us its revision for stale output
      // (复测第二轮问题 1).
      modelResult = regenerated;
      snapshot = winner;
    }
  }
}
