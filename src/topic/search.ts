import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Topic, TopicSummary } from '../types.js';
import { chatAppLink, threadAppLink } from '../im/lark/lark-hosts.js';
import { isNativeTopicId } from '../core/native-topic-id.js';
import { normalizeTime } from './source.js';
import { keywordScore } from './keyword.js';
import { cosine, summaryVector, validVector } from './embedding.js';
import { topicModelKey, type TopicModelClient } from './model-client.js';
import type { TopicSearchConfig } from './config.js';
import type { TopicStore } from './store.js';

export interface TopicSearchScope { principal: string; chatIds: readonly string[] | null }
export interface TopicSearchRequest {
  query: string;
  filters: { chatIds: string[]; timeBasis: 'topicCreated' | 'latestMessage'; from: string | null; to: string | null };
  mode: 'keyword' | 'hybrid' | 'auto';
  limit: number;
  cursor: string | null;
}
export interface TopicSearchItem {
  topicKey: string; chatId: string; title: string; url: string;
  matches: Array<{ summaryId: string; text: string; sourceMessageIds: string[] }>;
  updatedAt: string; sourceThroughAt?: string; topicCreatedAt?: string; latestMessageAt?: string;
}
export interface TopicSearchResponse {
  items: TopicSearchItem[];
  effectiveMode: 'keyword' | 'hybrid';
  degradedReasons: string[];
  coverage: { state: 'complete' | 'partial'; unindexedKnownTopics: number; examinedTopics: number; unknownDateTopics: number; budgetLimited: boolean };
  nextCursor: string | null;
}
export class TopicSearchError extends Error {
  constructor(readonly status: number, code: string) { super(code); }
}
function invalid(): never { throw new TopicSearchError(400, 'invalid_topic_search_request'); }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Record<string, unknown>;
}
export function parseTopicSearchRequest(raw: unknown): TopicSearchRequest {
  const r = record(raw), f = r.filters === undefined ? {} : record(r.filters);
  const query = r.query ?? '', mode = r.mode ?? 'auto', limit = r.limit ?? 10, cursor = r.cursor ?? null;
  if (typeof query !== 'string' || query.length > 512 || !['keyword', 'hybrid', 'auto'].includes(String(mode)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== null && (typeof cursor !== 'string' || cursor.length > 4096))) return invalid();
  const chats = f.chatIds ?? [];
  if (!Array.isArray(chats) || chats.length > 1000 || !chats.every(chat => typeof chat === 'string' && /^oc_[A-Za-z0-9_-]+$/.test(chat))) return invalid();
  const legacy = f.sourceFrom !== undefined || f.sourceTo !== undefined || r.sourceFrom !== undefined || r.sourceTo !== undefined;
  if (legacy && (f.timeBasis !== undefined || f.from !== undefined || f.to !== undefined)) return invalid();
  const basis = legacy ? 'latestMessage' : f.timeBasis ?? 'latestMessage';
  if (basis !== 'topicCreated' && basis !== 'latestMessage') return invalid();
  const date = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return invalid();
    try { return normalizeTime(value); } catch { return invalid(); }
  };
  const from = date(legacy ? f.sourceFrom ?? r.sourceFrom : f.from), to = date(legacy ? f.sourceTo ?? r.sourceTo : f.to);
  if ((from && to && from > to) || (!query.trim() && !from && !to)) return invalid();
  return { query: query.trim(), filters: { chatIds: [...new Set(chats)].sort(), timeBasis: basis, from, to }, mode: mode as TopicSearchRequest['mode'], limit, cursor: cursor as string | null };
}
interface Candidate { topic: Topic; summary?: TopicSummary; keyword: number; vector: number; fused: number }
interface Snapshot { bind: string; generation: number; expires: number; response: Omit<TopicSearchResponse, 'nextCursor'> }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class TopicSearchService {
  private readonly secret = randomBytes(32);
  private active = 0;
  private readonly principals = new Map<string, number>();
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(
    private readonly store: TopicStore,
    private readonly config: () => TopicSearchConfig,
    private readonly model: Pick<TopicModelClient, 'embed'>,
    private readonly options: { now?: () => number; maxTopics?: number; maxSummaries?: number; budgetMs?: number; cursorTtlMs?: number; brand?: (topic: Topic) => 'feishu' | 'lark' } = {},
  ) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private sign(payload: string): string { return createHmac('sha256', this.secret).update(payload).digest('base64url'); }
  private cursor(id: string, offset: number): string {
    const payload = Buffer.from(JSON.stringify({ id, offset })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }
  private page(id: string, snapshot: Snapshot, offset: number, limit: number): TopicSearchResponse {
    return { ...snapshot.response, items: snapshot.response.items.slice(offset, offset + limit), nextCursor: offset + limit < snapshot.response.items.length ? this.cursor(id, offset + limit) : null };
  }

  async search(raw: unknown, scope: TopicSearchScope): Promise<TopicSearchResponse> {
    if (!scope.principal) throw new TopicSearchError(401, 'topic_search_authentication_required');
    const active = this.principals.get(scope.principal) ?? 0;
    if (active >= 2 || this.active >= 8) throw new TopicSearchError(429, 'topic_search_busy');
    this.active++; this.principals.set(scope.principal, active + 1);
    try { return await this.execute(raw, scope); }
    finally {
      this.active--; const remaining = (this.principals.get(scope.principal) ?? 1) - 1;
      if (remaining) this.principals.set(scope.principal, remaining); else this.principals.delete(scope.principal);
    }
  }

  private async execute(raw: unknown, scope: TopicSearchScope): Promise<TopicSearchResponse> {
    if (!scope.principal) throw new TopicSearchError(401, 'topic_search_authentication_required');
    const config = this.config();
    if (!config.enabled) throw new TopicSearchError(403, 'topic_search_disabled');
    const request = parseTopicSearchRequest(raw);
    if (scope.chatIds && request.filters.chatIds.some(chat => !scope.chatIds!.includes(chat))) throw new TopicSearchError(403, 'topic_search_scope_denied');
    const allowed = request.filters.chatIds.length ? request.filters.chatIds : scope.chatIds ? [...new Set(scope.chatIds)].sort() : null;
    const profile = config.embedding.enabled && config.embedding.modelRef ? config.models[config.embedding.modelRef] : undefined;
    const bind = digest([scope.principal, scope.chatIds ? [...new Set(scope.chatIds)].sort() : null, { ...request, cursor: null }, profile ? topicModelKey(profile) : null]);
    const generation = this.store.generation(), started = this.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= started) this.snapshots.delete(id);
    if (request.cursor) {
      try {
        const [payload, signature, extra] = request.cursor.split('.');
        if (!payload || !signature || extra) throw new Error();
        const supplied = Buffer.from(signature), expected = Buffer.from(this.sign(payload));
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
        const { id, offset } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const snapshot = this.snapshots.get(id);
        if (!snapshot || snapshot.bind !== bind || snapshot.generation !== generation || snapshot.expires <= started || !Number.isInteger(offset) || offset < 0 || offset >= snapshot.response.items.length) throw new Error();
        return this.page(id, snapshot, offset, request.limit);
      } catch { throw new TopicSearchError(400, 'topic_search_cursor_expired'); }
    }
    const maxTopics = this.options.maxTopics ?? 10_000, maxSummaries = this.options.maxSummaries ?? 50_000;
    const budgetMs = this.options.budgetMs ?? 3000;
    const directory = this.store.authorizedTopics(allowed, maxTopics);
    const candidates: Candidate[] = [];
    let unindexed = 0, unknownDates = 0, budgetLimited = directory.truncated, sourcePartial = false, summaries = 0;
    const hasDate = !!(request.filters.from || request.filters.to);
    for (const topic of directory.topics) {
      if (!topic.summarizedThroughCursor) unindexed++;
      if (topic.sourceIncomplete || this.store.hasSourceCheckpoint(topic.topicKey) || (topic.latestMessageAt && (!topic.sourceThroughAt || topic.latestMessageAt > topic.sourceThroughAt))) sourcePartial = true;
      const date = request.filters.timeBasis === 'topicCreated' ? topic.topicCreatedAt : topic.latestMessageAt;
      if (hasDate && !date) { unknownDates++; continue; }
      if (hasDate && ((request.filters.from && date! < request.filters.from) || (request.filters.to && date! > request.filters.to))) continue;
      if (this.now() - started >= budgetMs) { budgetLimited = true; break; }
      candidates.push({ topic, keyword: request.query ? keywordScore(request.query, topic.title, '', []) : 1, vector: 0, fused: 0 });
      for (const summary of topic.summaries) {
        if (summaries >= maxSummaries || this.now() - started >= budgetMs) { budgetLimited = true; break; }
        summaries++;
        candidates.push({ topic, summary, keyword: request.query ? keywordScore(request.query, topic.title, summary.text, summary.keywords) : 1, vector: 0, fused: 0 });
      }
      if (budgetLimited && summaries >= maxSummaries) break;
    }
    const degraded: string[] = []; let effectiveMode: 'keyword' | 'hybrid' = 'keyword';
    if (request.query && request.mode !== 'keyword') {
      if (!profile) degraded.push('embedding_disabled');
      else {
        const remaining = budgetMs - (this.now() - started);
        if (remaining <= 0) degraded.push('embedding_budget_exhausted');
        else {
          const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, remaining); });
            const vector = await Promise.race([this.model.embed(profile, request.query, abort.signal), timeout]);
            if (!validVector(vector, profile.dimensions ?? 0)) throw new Error('invalid_vector');
            let usable = 0;
            for (const candidate of candidates) {
              if (!candidate.summary) continue;
              const stored = summaryVector(candidate.summary, topicModelKey(profile), profile.dimensions ?? 0);
              if (stored) { candidate.vector = Math.max(0, cosine(vector, stored)); usable++; }
            }
            if (usable) effectiveMode = 'hybrid';
            if (usable < summaries) degraded.push('embedding_partial');
          } catch { degraded.push('embedding_unavailable'); }
          finally { if (timer) clearTimeout(timer); abort.abort(); }
        }
      }
    }
    const tie = (a: Candidate, b: Candidate) => a.topic.topicKey.localeCompare(b.topic.topicKey) || (a.summary?.id ?? '').localeCompare(b.summary?.id ?? '');
    const keyword = candidates.filter(row => row.keyword > 0).sort((a, b) => b.keyword - a.keyword || tie(a, b));
    const vector = candidates.filter(row => row.vector > 0).sort((a, b) => b.vector - a.vector || tie(a, b));
    for (const channel of [keyword, vector]) channel.forEach((row, index) => { row.fused += 1 / (60 + index + 1); });
    const ranked = candidates.filter(row => row.keyword > 0 || row.vector > 0).sort((a, b) => {
      if (!request.query) {
        const date = (topic: Topic) => request.filters.timeBasis === 'topicCreated' ? topic.topicCreatedAt ?? '' : topic.latestMessageAt ?? '';
        return date(b.topic).localeCompare(date(a.topic)) || tie(a, b);
      }
      return (effectiveMode === 'hybrid' ? b.fused - a.fused : b.keyword - a.keyword) || tie(a, b);
    });
    const grouped = new Map<string, TopicSearchItem>();
    for (const row of ranked) {
      let item = grouped.get(row.topic.topicKey);
      if (!item) {
        const topic = row.topic, brand = this.options.brand?.(topic) ?? topic.sourceBrand ?? 'feishu';
        item = { topicKey: topic.topicKey, chatId: topic.chatId, title: topic.title,
          url: isNativeTopicId(topic.nativeThreadId) ? threadAppLink(topic.chatId, topic.nativeThreadId, brand) : chatAppLink(topic.chatId, brand),
          matches: [], updatedAt: topic.updatedAt, sourceThroughAt: topic.sourceThroughAt, topicCreatedAt: topic.topicCreatedAt, latestMessageAt: topic.latestMessageAt };
        grouped.set(topic.topicKey, item);
      }
      if (row.summary && item.matches.length < 3) item.matches.push({ summaryId: row.summary.id, text: row.summary.text.slice(0, 600), sourceMessageIds: row.summary.sourceMessageIds.slice(0, 20) });
    }
    if (grouped.size > 1000) budgetLimited = true;
    const response: Omit<TopicSearchResponse, 'nextCursor'> = {
      items: [...grouped.values()].slice(0, 1000), effectiveMode, degradedReasons: degraded,
      coverage: { state: budgetLimited || unindexed > 0 || sourcePartial || unknownDates > 0 ? 'partial' : 'complete', unindexedKnownTopics: unindexed, examinedTopics: directory.topics.length, unknownDateTopics: unknownDates, budgetLimited },
    };
    if (this.store.generation() !== generation) throw new TopicSearchError(503, 'topic_search_index_changed');
    const id = randomBytes(16).toString('base64url');
    const snapshot = { bind, generation, expires: started + (this.options.cursorTtlMs ?? 60_000), response };
    if (this.snapshots.size >= 20) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(id, snapshot);
    return this.page(id, snapshot, 0, request.limit);
  }
}
