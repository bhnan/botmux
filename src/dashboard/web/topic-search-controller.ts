import type { TopicSearchItem, TopicSearchRequest, TopicSearchResponse } from '../../topic/search.js';
import { sessionTopicKey, groupSessionsByTopic, type SessionTopicGroup } from './sessions.js';

export interface TopicSearchState { result: TopicSearchResponse | null; loading: boolean; error: string | null }
/** Transport state separate from React: one generation owns results, including pagination and errors. */
export class TopicSearchController {
  state: TopicSearchState = { result: null, loading: false, error: null };
  private generation = 0;
  private abort: AbortController | null = null;
  private request: TopicSearchRequest | null = null;
  constructor(private readonly transport: typeof fetch, private readonly changed: (state: TopicSearchState) => void) {}
  private publish(state: TopicSearchState): void { this.state = state; this.changed(state); }
  reset(): void {
    this.generation++; this.abort?.abort(); this.abort = null; this.request = null;
    this.publish({ result: null, loading: false, error: null });
  }
  async search(request: TopicSearchRequest): Promise<void> {
    this.reset(); this.request = request;
    await this.load(false);
  }
  async more(): Promise<void> { if (!this.state.loading && this.state.result?.nextCursor) await this.load(true); }
  async retry(): Promise<void> { if (this.request) await this.search({ ...this.request, cursor: null }); }
  private async load(append: boolean): Promise<void> {
    if (!this.request) return;
    const generation = this.generation, previous = this.state.result;
    const request = { ...this.request, cursor: append ? previous?.nextCursor ?? null : null };
    this.abort?.abort(); this.abort = new AbortController();
    this.publish({ result: previous, loading: true, error: null });
    try {
      const response = await this.transport('/api/topic-search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: this.abort.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(body.error === 'topic_search_disabled' ? 'disabled' : body.error === 'topic_search_cursor_expired' ? 'cursor_expired' : 'unavailable');
      }
      const result = await response.json() as TopicSearchResponse;
      if (generation !== this.generation) return;
      if (append && previous) {
        const seen = new Set(previous.items.map(item => item.topicKey));
        result.items = [...previous.items, ...result.items.filter(item => !seen.has(item.topicKey))];
      }
      this.publish({ result, loading: false, error: null });
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error instanceof Error && ['disabled', 'cursor_expired'].includes(error.message) ? error.message : 'unavailable';
      this.publish({ result: previous, loading: false, error: code });
    }
  }
}

/** Shared by the visible list and bulk-selection derivation: hidden search misses are never actionable. */
export function topicContentRows<T extends Record<string, any>>(rows: readonly T[], items: readonly TopicSearchItem[] | undefined): T[] {
  if (items === undefined) return [...rows];
  const keys = new Set(items.map(item => item.topicKey));
  return rows.filter(row => keys.has(sessionTopicKey(row)));
}

export function topicSearchGroups<T extends Record<string, any>>(
  rows: readonly T[], allRows: readonly T[], items: readonly TopicSearchItem[] | undefined, includeHistorical: boolean,
): SessionTopicGroup<T>[] {
  const groups = groupSessionsByTopic(rows);
  if (items === undefined) return groups;
  const available = new Map(groups.map(group => [group.key, group]));
  const existing = new Set(groupSessionsByTopic(allRows).map(group => group.key));
  return items.flatMap(item => {
    const group = available.get(item.topicKey);
    if (group) return [group];
    // Existing topics whose sessions fail Bot/status filters remain filtered. A persisted-only
    // topic has no invented session status and is shown when no explicit session constraint exists.
    if (existing.has(item.topicKey) || !includeHistorical) return [];
    return [{ key: item.topicKey, kind: 'thread' as const, chatId: item.chatId, title: item.title, rows: [], botCount: 0,
      activeCount: 0, closedCount: 0, inferredBotInputCount: 0, latestActivityAt: Date.parse(item.latestMessageAt ?? '') || 0,
      multiBot: false, inferredBotTriggered: false }];
  });
}

export function topicSearchRequest(query: string, chat: string, basis: 'topicCreated' | 'latestMessage', from: string, to: string, mode: 'auto' | 'keyword' | 'hybrid'): TopicSearchRequest {
  const date = (value: string) => value ? new Date(value).toISOString() : null;
  return { query, filters: { chatIds: chat ? [chat] : [], timeBasis: basis, from: date(from), to: date(to) }, mode, limit: 20, cursor: null };
}

export function safeTopicLink(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && ['applink.feishu.cn', 'applink.larksuite.com'].includes(url.hostname) && ['/client/thread/open', '/client/chat/open'].includes(url.pathname) && !url.username && !url.password) return url.toString();
  } catch { /* no external or executable scheme */ }
  return undefined;
}
