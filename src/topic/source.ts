/** Source-message normalization and incremental slicing (spec §5.1/§5.2).
 *
 * The source adapter contract: the reader returns ONE topic's thread messages
 * oldest→newest, deduplicated by message id, plus whether the window was
 * truncated and — when a cursor was requested — whether the read PROVED
 * continuity by scanning back to that cursor. Lark message ids are opaque —
 * order comes from the array position the adapter resolved, never from
 * string comparison; `create_time` is display metadata only (same-millisecond
 * messages must survive slicing, spec §5.2 step 4).
 *
 * Incremental boundary: `summarizedThroughCursor` encodes the id of the last
 * message successfully processed. Continuity to that cursor is proven only by
 * the reader reaching it (or the cursor being present in the window); a
 * window that is merely NEWER than the cursor is not proof — the gap was
 * never observed and must never be advanced over (change.md 复测问题 2).
 */
import type { TopicIdentity } from './identity.js';

export interface SourceMessage {
  messageId: string;
  senderType?: 'user' | 'app';
  senderName?: string;
  /** Lark create_time, normalized to epoch milliseconds. */
  createTimeMs?: number;
  text: string;
}

/** What a reader receives: the routing identity plus the host-assigned read
 * hint (which lark app's daemon can fetch this thread) and the topic's
 * success cursor the reader must scan back to (continuity proof). */
export type TopicReadTarget = TopicIdentity & { larkAppId?: string; untilMessageId?: string };

export interface TopicHistoryWindow {
  messages: SourceMessage[];
  /** True when the read does NOT cover the full visible history (budget
   * capped, or an after-cursor increment window). Legacy convenience flag;
   * the authoritative coverage signal is `reachedOldest`. */
  truncated: boolean;
  /** When a cursor was requested: whether the read PROVED continuity by
   * actually reaching the cursor message (scanning back to it). A tail
   * window whose messages are merely newer than the cursor is NOT proof —
   * the gap in between was never observed (change.md 复测问题 2). */
  cursorFound?: boolean;
  /** Deletion-check coverage evidence (复测第二轮问题 2): true ONLY when the
   * scan paged through to the thread's oldest message within budget. An
   * after-cursor increment window is never full coverage — cited refs before
   * the cursor are deliberately outside it and must NOT be judged deleted. */
  reachedOldest?: boolean;
  /** Every message id observed across the whole scan (present only when
   * reachedOldest). The ONLY set a deletion check may compare against. */
  historyIds?: string[];
  /** Root message create time from the platform (change.md §3): the only
   * evidence allowed to set Topic.topicCreatedAt. Absent = unknown — the
   * earliest message of a truncated window is NOT a substitute. */
  rootCreatedAtMs?: number;
}

/** Opaque, forward-compatible cursor: the last processed message id. */
export function encodeSourceCursor(messageId: string): string {
  return `msg:${messageId}`;
}

export function decodeSourceCursor(cursor: string | undefined): string {
  if (!cursor?.startsWith('msg:')) return '';
  return cursor.slice('msg:'.length);
}

/** Drop duplicates by message id, preserving first occurrence and adapter
 * order (a repeated page overlap is the expected shape). */
export function dedupeSourceMessages(messages: readonly SourceMessage[]): SourceMessage[] {
  const seen = new Set<string>();
  const out: SourceMessage[] = [];
  for (const message of messages) {
    if (!message?.messageId || seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    out.push(message);
  }
  return out;
}

export interface SliceIncrementOptions {
  /** Cursor of the last successfully processed message (undefined = first run). */
  cursor?: string;
  /** First run: only messages at/after this epoch-ms boundary enter the batch
   * (config.initialLookbackDays). Older messages are skipped entirely —
   * coverage below the boundary is never claimed. */
  firstRunSinceMs?: number;
  /** Upper bound of one batch; the rest waits for the next run. */
  maxBatchMessages: number;
  /** Reader's continuity proof for the requested cursor (window.cursorFound).
   * Continuity is established ONLY by the reader scanning back to the cursor
   * or by the cursor message being present in the window — never by the
   * window merely being newer than the cursor (that skips the gap). */
  cursorFound?: boolean;
}

export interface SliceIncrementResult {
  hasIncrement: boolean;
  /** Why a window with no cursor match produced no increment. */
  skippedReason?: 'cursor_beyond_window';
  /** This run's fixed end boundary (commit only on success). */
  batchEndCursor?: string;
  /** ISO timestamp of the oldest message in the batch (coverage start). */
  batchCoverageStartAt?: string;
}

/** Slice the increment to process. The end boundary is FIXED at slice time:
 * messages arriving later are not in this batch (spec §5.2 step 6). */
export function sliceIncrement(messagesIn: readonly SourceMessage[], options: SliceIncrementOptions): { batch: SourceMessage[] } & SliceIncrementResult {
  const messages = dedupeSourceMessages(messagesIn);
  const cursorId = decodeSourceCursor(options.cursor);
  let startIndex = 0;
  if (cursorId) {
    const cursorIndex = messages.findIndex(m => m.messageId === cursorId);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    } else if (options.cursorFound === true) {
      // Reader scanned back to the cursor and returned the contiguous block
      // after it (cursor excluded from the window): process the whole window.
      startIndex = 0;
    } else {
      // Continuity NOT proven (budget exhausted or window is a detached
      // tail): processing it would silently skip the unobserved gap. Stop
      // loudly instead of advancing a success cursor over missing messages.
      return { batch: [], hasIncrement: false, skippedReason: 'cursor_beyond_window' };
    }
  } else if (options.firstRunSinceMs !== undefined) {
    while (startIndex < messages.length
      && messages[startIndex].createTimeMs !== undefined
      && messages[startIndex].createTimeMs! < options.firstRunSinceMs) {
      startIndex++;
    }
  }
  const candidates = messages.slice(startIndex);
  if (!candidates.length) return { batch: [], hasIncrement: false };
  const batch = candidates.slice(0, options.maxBatchMessages);
  const first = batch[0];
  const last = batch[batch.length - 1];
  return {
    batch,
    hasIncrement: true,
    batchEndCursor: encodeSourceCursor(last.messageId),
    batchCoverageStartAt: first.createTimeMs !== undefined ? new Date(first.createTimeMs).toISOString() : undefined,
  };
}

/** Cited source refs that vanished from the thread (deletion/revocation,
 * spec §5.4). Runs ONLY with explicit full-coverage evidence
 * (`reachedOldest` + `historyIds`): an after-cursor increment window is
 * never such evidence — refs before the cursor are outside it by design and
 * must not be judged deleted (复测第二轮问题 2). */
export function findVanishedSourceRefs(window: TopicHistoryWindow, citedIds: readonly string[]): string[] {
  if (window.reachedOldest !== true) return [];
  const observable = new Set<string>([
    ...(window.historyIds ?? []),
    ...dedupeSourceMessages(window.messages).map(m => m.messageId),
  ]);
  return citedIds.filter(id => id && !observable.has(id));
}

export type TopicHistoryReader = (target: TopicReadTarget) => Promise<TopicHistoryWindow>;
