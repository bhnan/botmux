/** Unified topic search service (spec §6).
 *
 * The service ranks the ALREADY-AUTHORIZED candidate set (the Dashboard API
 * layer supplies visible topics; query filters only NARROW that set, spec
 * §6.2). Channels: keyword always; vector when enabled and healthy — a
 * vector failure degrades to keyword results with a reason instead of
 * failing the whole query (spec §6.1). Every topic yields at most ONE result
 * carrying its best-matching summaries.
 *
 * Budgets are explicit: over-budget candidate sets report `partial`
 * coverage instead of silently pretending completeness (spec §6.1).
 */
import { createHash } from 'node:crypto';
import type { Topic } from '../types.js';
import { keywordRecall, type KeywordTopicScore } from './keyword.js';
import { fuseRankings, vectorRecall } from './vector.js';
import type { TopicEmbeddingResult } from './embedding-client.js';

export const MAX_QUERY_LENGTH = 200;
export const MAX_LIMIT = 50;
/** Candidate-scan budget; beyond this the result is marked partial. */
export const MAX_CANDIDATES = 2_000;

export type TopicSearchMode = 'keyword' | 'hybrid' | 'auto';

/** Two independent, user-selectable time bases for date filtering
 * (change.md §3). They are never auto-combined: the chosen basis alone
 * decides inclusion, and both are SOURCE-derived topic attributes — never
 * summary generation time, coverage bounds, or the success cursor. */
export type TopicTimeBasis = 'topicCreated' | 'latestMessage';

export interface TopicSearchFilters {
  /** Narrow the authorized set further; never widen it. */
  chatIds?: string[];
  /** Which time basis the date range applies to. Defaults to 'latestMessage'
   * when a range is given without a basis (the UI always sends it
   * explicitly so the user sees what they selected). */
  timeBasis?: TopicTimeBasis;
  /** ISO-8601 bounds for the chosen basis (inclusive). */
  from?: string | null;
  to?: string | null;
  /** LEGACY (pre-change.md) aliases: bounds on source-message time. Mapped
   * onto { timeBasis: 'latestMessage', from, to }; explicit new-style params
   * win when both are present. */
  sourceFrom?: string | null;
  sourceTo?: string | null;
}

export interface TopicSearchInput {
  query: string;
  filters?: TopicSearchFilters;
  mode: TopicSearchMode;
  limit: number;
  cursor?: string | null;
  /** Index version the cursor was minted against (catalog fingerprint from
   * the store). A page request whose version no longer matches is rejected
   * with cursor_invalid — the ranking shifted under the pager (spec §6.2). */
  indexVersion?: string;
}

export interface TopicSearchMatch {
  summaryId: string;
  text: string;
  sourceMessageIds: string[];
}

export interface TopicSearchItem {
  topicKey: string;
  title: string;
  url: string;
  matches: TopicSearchMatch[];
  updatedAt: string;
  sourceThroughAt?: string;
  /** Source-derived time bases (change.md §3); absent = not yet observed. */
  topicCreatedAt?: string;
  latestMessageAt?: string;
}

export interface TopicSearchOutput {
  items: TopicSearchItem[];
  effectiveMode: 'keyword' | 'hybrid';
  degradedReasons: string[];
  coverage: { state: 'complete' | 'partial'; unindexedKnownTopics: number };
  nextCursor: string | null;
}

export class TopicSearchValidationError extends Error {
  override readonly name = 'TopicSearchValidationError';
  constructor(readonly code: 'query_invalid' | 'limit_invalid' | 'cursor_invalid') {
    super(`topic_search_invalid:${code}`);
  }
}

export interface QueryEmbedder {
  (text: string): Promise<TopicEmbeddingResult>;
}

interface CursorPayload {
  offset: number;
  sig: string;
}

function cursorSignature(input: TopicSearchInput): string {
  return createHash('sha256').update(JSON.stringify({
    query: input.query,
    filters: input.filters ?? {},
    mode: input.mode,
    limit: input.limit,
    indexVersion: input.indexVersion ?? '',
  })).digest('hex').slice(0, 16);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | null | undefined, sig: string): number {
  if (raw === null || raw === undefined) return 0;
  try {
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
    if (payload.sig !== sig || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
      throw new TopicSearchValidationError('cursor_invalid');
    }
    return payload.offset;
  } catch (error) {
    if (error instanceof TopicSearchValidationError) throw error;
    throw new TopicSearchValidationError('cursor_invalid');
  }
}

/** Normalize legacy + new-style date params into one basis + range. */
function resolveTimeFilter(filters: TopicSearchFilters): { basis: TopicTimeBasis; from?: number; to?: number } {
  const from = filters.from ?? filters.sourceFrom ?? null;
  const to = filters.to ?? filters.sourceTo ?? null;
  const basis = filters.timeBasis ?? 'latestMessage';
  return {
    basis,
    ...(from ? { from: Date.parse(from) } : {}),
    ...(to ? { to: Date.parse(to) } : {}),
  };
}

function hasDateFilter(filters: TopicSearchFilters): boolean {
  return !!(filters.from || filters.to || filters.sourceFrom || filters.sourceTo);
}

/** Date filtering by the ONE selected basis (change.md §3): the chosen basis
 * field alone decides; the other basis is never implicitly AND'ed. Topics
 * whose basis field is still unknown (never observed from the source) are
 * excluded from date-filtered results rather than faked from summary
 * fields. */
function topicWithinTimeFilter(topic: Topic, time: { basis: TopicTimeBasis; from?: number; to?: number }): boolean {
  if (time.from === undefined && time.to === undefined) return true;
  const field = time.basis === 'topicCreated' ? topic.topicCreatedAt : topic.latestMessageAt;
  if (!field) return false; // unknown source time: cannot prove in-range
  const at = Date.parse(field);
  if (time.from !== undefined && at < time.from) return false;
  if (time.to !== undefined && at > time.to) return false;
  return true;
}

export interface TopicSearchServiceDeps {
  /** Embedding-backed query vectorizer; absent = keyword-only. */
  embedQuery?: QueryEmbedder;
}

export class TopicSearchService {
  private readonly embedQuery: QueryEmbedder | undefined;

  constructor(deps: TopicSearchServiceDeps) {
    this.embedQuery = deps.embedQuery;
  }

  async search(input: TopicSearchInput, candidates: readonly Topic[]): Promise<TopicSearchOutput> {
    const query = input.query?.trim() ?? '';
    // Date-only queries are first-class: an empty keyword is valid when a
    // date range (or chat filter) narrows the set (change.md §3: 不输入关键
    // 词，仅选择时间口径和范围，也能获得话题列表).
    const filters = input.filters ?? {};
    const narrowing = hasDateFilter(filters) || !!(filters.chatIds && filters.chatIds.length);
    if ((!query && !narrowing) || query.length > MAX_QUERY_LENGTH) throw new TopicSearchValidationError('query_invalid');
    const limit = Math.floor(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TopicSearchValidationError('limit_invalid');

    const sig = cursorSignature(input);
    const offset = decodeCursor(input.cursor, sig);

    let visible = candidates;
    if (filters.chatIds?.length) {
      const allowed = new Set(filters.chatIds);
      visible = visible.filter(t => allowed.has(t.chatId));
    }
    // Filter FIRST, budget after: out-of-scope topics must not consume the
    // candidate budget and squeeze out legal results (change.md §5).
    const timeFilter = resolveTimeFilter(filters);
    visible = visible.filter(t => topicWithinTimeFilter(t, timeFilter));

    const degradedReasons: string[] = [];
    const overBudget = visible.length > MAX_CANDIDATES;
    const scanned = overBudget ? visible.slice(0, MAX_CANDIDATES) : visible;

    const keywordRanked = query ? keywordRecall(scanned, query) : [];
    const keywordByTopic = new Map(keywordRanked.map(entry => [entry.topicKey, entry]));

    let vectorByTopic: Map<string, { summaryId: string; similarity: number }> | undefined;
    const wantsVector = query && (input.mode === 'hybrid' || (input.mode === 'auto' && scanned.length > 0));
    if (wantsVector) {
      if (!this.embedQuery) {
        degradedReasons.push('embedding_disabled');
      } else {
        const embedded = await this.embedQuery(query);
        if (embedded.ok) {
          const vectorTopics = vectorRecall(scanned, embedded.vector, embedded.modelKey);
          vectorByTopic = new Map(vectorTopics.map(v => [v.topicKey, { summaryId: v.summaryId, similarity: v.similarity }]));
        } else {
          // Provider failure degrades to keyword; the query still answers.
          degradedReasons.push('embedding_unavailable');
        }
      }
    }

    const hybrid = vectorByTopic !== undefined;
    let orderedTopicKeys: string[];
    if (!query) {
      // Date-only browsing: newest observed activity first, deterministic.
      orderedTopicKeys = [...scanned]
        .sort((a, b) => (Date.parse(b.latestMessageAt ?? '') || 0) - (Date.parse(a.latestMessageAt ?? '') || 0) || a.topicKey.localeCompare(b.topicKey))
        .map(t => t.topicKey);
    } else if (hybrid) {
      const fused = fuseRankings(keywordRanked.map(k => k.topicKey), [...vectorByTopic!.keys()]);
      orderedTopicKeys = [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key]) => key);
    } else {
      orderedTopicKeys = keywordRanked.map(k => k.topicKey);
    }

    const page = orderedTopicKeys.slice(offset, offset + limit);
    const byTopicKey = new Map(scanned.map(t => [t.topicKey, t]));
    const items: TopicSearchItem[] = page.map(topicKey => {
      const topic = byTopicKey.get(topicKey)!;
      const keyword: KeywordTopicScore | undefined = keywordByTopic.get(topicKey);
      const matches: TopicSearchMatch[] = [];
      const seenSummary = new Set<string>();
      // Keyword snippets first (explanatory), then the vector-hit summary.
      for (const summary of keyword?.matchedSummaries ?? []) {
        if (seenSummary.has(summary.id)) continue;
        seenSummary.add(summary.id);
        matches.push({ summaryId: summary.id, text: summary.text, sourceMessageIds: summary.sourceMessageIds });
      }
      const vectorHit = vectorByTopic?.get(topicKey);
      if (vectorHit && !seenSummary.has(vectorHit.summaryId)) {
        const summary = topic.summaries.find(s => s.id === vectorHit.summaryId);
        if (summary) {
          seenSummary.add(summary.id);
          matches.push({ summaryId: summary.id, text: summary.text, sourceMessageIds: summary.sourceMessageIds });
        }
      }
      return {
        topicKey: topic.topicKey,
        title: topic.title,
        url: topicUrl(topic),
        matches,
        updatedAt: topic.updatedAt,
        ...(topic.sourceThroughAt ? { sourceThroughAt: topic.sourceThroughAt } : {}),
        ...(topic.topicCreatedAt ? { topicCreatedAt: topic.topicCreatedAt } : {}),
        ...(topic.latestMessageAt ? { latestMessageAt: topic.latestMessageAt } : {}),
      };
    });

    const nextOffset = offset + page.length;
    return {
      items,
      effectiveMode: hybrid ? 'hybrid' : 'keyword',
      degradedReasons,
      coverage: {
        state: overBudget ? 'partial' : 'complete',
        unindexedKnownTopics: overBudget ? visible.length - MAX_CANDIDATES : 0,
      },
      nextCursor: nextOffset < orderedTopicKeys.length ? encodeCursor({ offset: nextOffset, sig }) : null,
    };
  }
}

/** Jump URL for a topic. v1: the Lark client app link via the native thread
 * handle when present; otherwise a chat jump. The daemon/API layer may
 * substitute richer URLs — this is the validated minimum. */
function topicUrl(topic: Topic): string {
  if (topic.nativeThreadId) {
    return `lark://client/chat/${topic.chatId}/thread/${topic.nativeThreadId}`;
  }
  return `lark://client/chat/${topic.chatId}/${topic.rootMessageId}`;
}
