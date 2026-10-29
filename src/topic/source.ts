/** Source-message normalization and incremental slicing (spec §5.1/§5.2).
 *
 * The source adapter contract: the reader returns ONE topic's thread messages
 * oldest→newest, deduplicated by message id, plus whether the window was
 * truncated (thread longer than the read budget). Lark message ids are
 * opaque — order comes from the array position the adapter resolved, never
 * from string comparison; `create_time` is display metadata only
 * (same-millisecond messages must survive slicing, spec §5.2 step 4).
 *
 * Incremental boundary: `summarizedThroughCursor` encodes the id of the last
 * message successfully processed. There is no server-side "since" parameter —
 * the adapter reads the bounded thread window and slicing happens here.
 * When the window's tail outruns the cursor (long threads), the cursor
 * message leaves the visible window; slicing then relies on the recorded
 * `sourceThroughAt` time to prove the whole window is newer than everything
 * already processed. Without that proof the run reports `cursorBeyondWindow`
 * instead of silently reprocessing or silently stalling.
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

export interface TopicHistoryWindow {
  messages: SourceMessage[];
  /** True when the read hit its budget — older messages exist but were not
   * fetched. Deletion checks must not run on a truncated window. */
  truncated: boolean;
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
  /** Epoch-ms of the newest input already processed (Topic.sourceThroughAt).
   * Used only when the cursor message has left the visible window. */
  sourceThroughAtMs?: number;
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
    } else {
      // Cursor message is outside the visible window. Proceed only when the
      // recorded processing time proves every visible message is newer;
      // otherwise stop loudly (skippedReason) rather than double-process or
      // silently stall the topic forever.
      const windowStartMs = messages[0]?.createTimeMs;
      const provable = options.sourceThroughAtMs !== undefined
        && windowStartMs !== undefined
        && windowStartMs >= options.sourceThroughAtMs;
      if (!provable) return { batch: [], hasIncrement: false, skippedReason: 'cursor_beyond_window' };
      startIndex = 0;
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
 * spec §5.4). Runs ONLY over a non-truncated window — on a truncated window a
 * ref outside the fetched era is indistinguishable from a deleted one, so
 * reporting it would destroy valid summaries. */
export function findVanishedSourceRefs(window: TopicHistoryWindow, citedIds: readonly string[]): string[] {
  if (window.truncated) return [];
  const observable = new Set(dedupeSourceMessages(window.messages).map(m => m.messageId));
  return citedIds.filter(id => id && !observable.has(id));
}

export type TopicHistoryReader = (identity: TopicIdentity) => Promise<TopicHistoryWindow>;
