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

export interface TopicSearchFilters {
  /** Narrow the authorized set further; never widen it. */
  chatIds?: string[];
  /** ISO-8601 bounds on SOURCE message time (not summary generation time). */
  sourceFrom?: string | null;
  sourceTo?: string | null;
}

export interface TopicSearchInput {
  query: string;
  filters?: TopicSearchFilters;
  mode: TopicSearchMode;
  limit: number;
  cursor?: string | null;
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

/** Topic's source-time window overlaps the filter bounds? Coverage fields are
 * optional (a topic summarized long ago may lack them) — missing bounds keep
 * the topic (filters narrow, absence must not silently exclude history). */
function sourceWindowOverlaps(topic: Topic, filters: TopicSearchFilters): boolean {
  const from = filters.sourceFrom ? Date.parse(filters.sourceFrom) : undefined;
  const to = filters.sourceTo ? Date.parse(filters.sourceTo) : undefined;
  if (from === undefined && to === undefined) return true;
  const start = topic.coverageStartAt ? Date.parse(topic.coverageStartAt) : undefined;
  const end = topic.sourceThroughAt ? Date.parse(topic.sourceThroughAt) : undefined;
  if (start !== undefined && to !== undefined && start > to) return false;
  if (end !== undefined && from !== undefined && end < from) return false;
  if (start === undefined && end === undefined) return false;
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
    if (!query || query.length > MAX_QUERY_LENGTH) throw new TopicSearchValidationError('query_invalid');
    const limit = Math.floor(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new TopicSearchValidationError('limit_invalid');

    const filters = input.filters ?? {};
    const sig = cursorSignature(input);
    const offset = decodeCursor(input.cursor, sig);

    let visible = candidates;
    if (filters.chatIds?.length) {
      const allowed = new Set(filters.chatIds);
      visible = visible.filter(t => allowed.has(t.chatId));
    }
    visible = visible.filter(t => sourceWindowOverlaps(t, filters));

    const degradedReasons: string[] = [];
    const overBudget = visible.length > MAX_CANDIDATES;
    const scanned = overBudget ? visible.slice(0, MAX_CANDIDATES) : visible;

    const keywordRanked = keywordRecall(scanned, query);
    const keywordByTopic = new Map(keywordRanked.map(entry => [entry.topicKey, entry]));

    let vectorByTopic: Map<string, { summaryId: string; similarity: number }> | undefined;
    const wantsVector = input.mode === 'hybrid' || (input.mode === 'auto' && scanned.length > 0);
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
    if (hybrid) {
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
