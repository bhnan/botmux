/** Temporary provider tokens/raw page tails never inherit the summary retention policy. */
export const TOPIC_SOURCE_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

import { createHash } from 'node:crypto';

/** A durable message boundary, never a provider's expiring pagination token. */
export interface TopicCursor { time: string; ids: string[] }
export interface TopicMessage { id: string; createdAt: string; text: string; deleted?: boolean }

export function normalizeTime(value: string): string {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(value))) throw new Error('invalid_source_time');
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(0); calendar.setUTCFullYear(Number(year), Number(month), 0);
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > calendar.getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new Error('invalid_source_time');
  return new Date(value).toISOString();
}

export function topicSourceFingerprint(message: TopicMessage): string {
  return createHash('sha256').update(JSON.stringify([message.createdAt, message.text, message.deleted === true])).digest('hex');
}

export function encodeCursor(cursor: TopicCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, time: normalizeTime(cursor.time), ids: [...new Set(cursor.ids)].sort() })).toString('base64url');
}

export function decodeCursor(value: string): TopicCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || !Array.isArray(parsed.ids) || !parsed.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) throw new Error();
    return { time: normalizeTime(parsed.time), ids: [...new Set<string>(parsed.ids)] };
  } catch { throw new Error('invalid_source_cursor'); }
}

export function coversCursor(next: TopicCursor, previous: TopicCursor): boolean {
  const a = Date.parse(next.time), b = Date.parse(previous.time);
  return a > b || (a === b && previous.ids.every(id => next.ids.includes(id)));
}

/** A page is a proven ascending slice of one native thread, never an unverified chat-tail filter. */
export interface TopicSourcePage {
  sourceBrand?: 'feishu' | 'lark';
  messages: TopicMessage[];
  hasMore: boolean;
  nextToken?: string;
  verifiedThread: boolean;
  sourceId?: string;
  nativeThreadId?: string;
  topicCreatedAt?: string;
  latestMessageAt?: string;
}
export type TopicPageReader = (token: string | undefined, signal: AbortSignal) => Promise<TopicSourcePage>;

/** Ephemeral traversal progress is NOT the successful summary cursor. Safe to discard/restart. */
export interface TopicSourceCheckpoint {
  expiresAt?: number;
  baseCursor: string | null;
  sourceId?: string;
  token?: string;
  pending: TopicMessage[];
  exhausted: boolean;
  lastPageTime?: string;
  seenTokens: string[];
  startedAt: string;
  coverageStartAt: string;
}
export interface TopicReadResult {
  messages: TopicMessage[];
  inspected: TopicMessage[];
  cursor: string | null;
  checkpoint: TopicSourceCheckpoint | null;
  partial: boolean;
  pages: number;
}
export interface TopicReadOptions {
  cursor?: string;
  checkpoint?: TopicSourceCheckpoint | null;
  coverageStartAt: string;
  now: string;
  maxPages: number;
  maxMessages: number;
  maxChars: number;
  signal: AbortSignal;
  /** Called on verified source data, before summarization. Observation survives a model failure. */
  isRevision?: (message: TopicMessage) => boolean;
  observe: (times: { createdAt?: string; latestAt?: string; nativeThreadId?: string; sourceBrand?: 'feishu' | 'lark' }) => void;
}

/** Consume a contiguous prefix; a full page can be split across commits without discarding its tail.
 * A scan before the summary boundary may checkpoint with zero messages, enabling bounded catch-up
 * even when the API has no thread since-time filter. Every accepted prefix is ordered and verified.
 */
export async function readTopicIncrement(reader: TopicPageReader, options: TopicReadOptions): Promise<TopicReadResult> {
  for (const value of [options.maxPages, options.maxMessages, options.maxChars]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid_topic_source_budget');
  }
  const previous = options.cursor ? decodeCursor(options.cursor) : null;
  const coverage = normalizeTime(options.coverageStartAt);
  let scan: TopicSourceCheckpoint;
  if (options.checkpoint && options.checkpoint.baseCursor === (options.cursor ?? null) && options.checkpoint.coverageStartAt === coverage) {
    scan = structuredClone(options.checkpoint);
  } else scan = { baseCursor: options.cursor ?? null, pending: [], exhausted: false, seenTokens: [], startedAt: normalizeTime(options.now), coverageStartAt: coverage };
  const selected: TopicMessage[] = [], inspected: TopicMessage[] = [];
  const seen = new Map<string, string>();
  let chars = 0, pages = 0;
  const isNew = (message: TopicMessage): boolean => message.createdAt >= coverage && (!previous || message.createdAt > previous.time || (message.createdAt === previous.time && !previous.ids.includes(message.id)));
  while (true) {
    options.signal.throwIfAborted();
    if (scan.pending.length) {
      const message = scan.pending[0];
      if (message.createdAt > scan.startedAt) {
        // Freeze the batch's upper bound: arrivals while providers run belong to a later batch.
        scan.pending = []; scan.exhausted = true; scan.token = undefined;
        break;
      }
      const duplicate = seen.get(message.id);
      const fingerprint = topicSourceFingerprint(message);
      if (duplicate && duplicate !== fingerprint) throw new Error('topic_source_changed_during_scan');
      if (!duplicate && (isNew(message) || options.isRevision?.(message))) {
        const cost = message.text.length + message.id.length + message.createdAt.length + 128;
        if (selected.length >= options.maxMessages || chars + cost > options.maxChars) {
          if (!selected.length) throw new Error('topic_source_message_over_budget');
          break; // Keep this exact message and the remainder for the next successful batch.
        }
        selected.push(message); chars += cost;
      }
      scan.pending.shift();
      if (!duplicate) { inspected.push(message); seen.set(message.id, fingerprint); }
      continue;
    }
    if (scan.exhausted || pages >= options.maxPages || selected.length >= options.maxMessages) break;
    const page = await reader(scan.token, options.signal);
    options.signal.throwIfAborted(); pages++;
    if (!page.verifiedThread) throw new Error('topic_source_unverified_thread');
    if (scan.sourceId && page.sourceId !== scan.sourceId) throw new Error('topic_source_identity_changed');
    if (page.sourceId) scan.sourceId = page.sourceId;
    if (!Array.isArray(page.messages) || page.messages.length > 50 || typeof page.hasMore !== 'boolean') throw new Error('invalid_topic_source_page');
    if (page.hasMore && (!page.nextToken || typeof page.nextToken !== 'string' || page.nextToken.length > 4096 || scan.seenTokens.includes(page.nextToken))) throw new Error('topic_source_pagination_loop');
    const messages = page.messages.map(raw => {
      if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 256 || typeof raw.text !== 'string' || raw.text.length > 256_000 || (raw.deleted !== undefined && typeof raw.deleted !== 'boolean')) throw new Error('invalid_topic_source_message');
      return { ...raw, createdAt: normalizeTime(raw.createdAt) };
    });
    let time = scan.lastPageTime;
    for (const message of messages) {
      if (time && message.createdAt < time) {
        // Some APIs repeat the last item of the previous page; arbitrary backwards paging is unsafe.
        throw new Error('topic_source_unordered_page');
      }
      time = message.createdAt;
    }
    const latest = [page.latestMessageAt ? normalizeTime(page.latestMessageAt) : '', time ?? ''].sort().at(-1);
    if (page.sourceBrand !== undefined && page.sourceBrand !== 'feishu' && page.sourceBrand !== 'lark') throw new Error('invalid_topic_source_brand');
    options.observe({ sourceBrand: page.sourceBrand, nativeThreadId: page.nativeThreadId, createdAt: page.topicCreatedAt ? normalizeTime(page.topicCreatedAt) : undefined, latestAt: latest || undefined });
    scan.pending = messages;
    scan.lastPageTime = time;
    scan.exhausted = !page.hasMore;
    scan.token = page.hasMore ? page.nextToken : undefined;
    if (scan.token) scan.seenTokens.push(scan.token);
    // Traversal tokens are ephemeral and bounded. Restart from durable cursor rather than retain
    // an unbounded token chain. Long scans still advance through committed message prefixes.
    if (scan.seenTokens.length > 10_000) throw new Error('topic_source_scan_budget');
  }
  let cursor = options.cursor ?? null;
  if (selected.length) {
    const time = selected.at(-1)!.createdAt;
    const ids = selected.filter(message => message.createdAt === time).map(message => message.id);
    if (previous?.time === time) ids.push(...previous.ids);
    if (!previous || time >= previous.time) cursor = encodeCursor({ time, ids });
  }
  const partial = !scan.exhausted || scan.pending.length > 0;
  scan.baseCursor = cursor;
  return { messages: selected, inspected, cursor, checkpoint: partial ? scan : null, partial, pages };
}
