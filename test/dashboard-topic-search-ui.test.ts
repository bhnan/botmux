import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TopicGroupsView,
  effectiveSessionSearchQuery,
  initialTopicSearchState,
  requestTopicSearch,
  topicSearchReducer,
  type TopicSearchAction,
  type TopicSearchHit,
  type TopicSearchViewState,
} from '../src/dashboard/web/sessions-page.js';
import { sessionTopicKey } from '../src/dashboard/web/sessions.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

const t = createDashboardTranslator('zh');

function hit(overrides: Partial<TopicSearchHit> & { topicKey: string }): TopicSearchHit {
  return {
    title: overrides.topicKey,
    matches: [{
      summaryId: `${overrides.topicKey}-m1`,
      text: `summary for ${overrides.topicKey}`,
      sourceMessageIds: ['om_source'],
    }],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function readyState(
  items: TopicSearchHit[],
  overrides: Partial<TopicSearchViewState> = {},
): TopicSearchViewState {
  return {
    ...initialTopicSearchState,
    status: 'ready',
    query: 'needle',
    requestId: 1,
    items,
    ...overrides,
  };
}

function row(sessionId: string, rootMessageId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    chatId: 'oc_coding',
    rootMessageId,
    scope: 'thread' as const,
    larkAppId: `app_${sessionId}`,
    botName: `Bot ${sessionId}`,
    cliId: 'codex',
    status: 'idle',
    title: `title ${sessionId}`,
    lastMessageAt: 100,
    ...overrides,
  };
}

function renderTopics(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(TopicGroupsView, {
    selected: new Set<string>(),
    hidden: false,
    onToggleSelect: () => {},
    onOpen: () => {},
    onHistory: () => {},
    onLocate: async () => true,
    onRestart: () => {},
    onLock: () => {},
    onClose: () => {},
    ...props,
  }));
}

function apply(state: TopicSearchViewState, action: TopicSearchAction): TopicSearchViewState {
  return topicSearchReducer(state, action);
}

describe('topic content search request handling', () => {
  it('ignores a response from a superseded query', () => {
    let state = apply(initialTopicSearchState, { type: 'start', query: 'first', requestId: 1 });
    state = apply(state, { type: 'start', query: 'second', requestId: 2 });

    const stale = apply(state, {
      type: 'success',
      query: 'first',
      requestId: 1,
      items: [hit({ topicKey: 'thread:oc:om_first' })],
      coverage: { state: 'complete', unindexedKnownTopics: 0 },
      degradedReasons: [],
    });
    expect(stale).toBe(state);
    expect(stale.items).toEqual([]);

    const staleFailure = apply(state, {
      type: 'failure', query: 'first', requestId: 1, disabled: false,
    });
    expect(staleFailure).toBe(state);

    const applied = apply(state, {
      type: 'success',
      query: 'second',
      requestId: 2,
      items: [hit({ topicKey: 'thread:oc:om_second' })],
      coverage: { state: 'complete', unindexedKnownTopics: 0 },
      degradedReasons: [],
    });
    expect(applied.status).toBe('ready');
    expect(applied.items.map(item => item.topicKey)).toEqual(['thread:oc:om_second']);
  });

  it('short-circuits a blank query before touching the network', async () => {
    const fetchImpl = vi.fn();
    await expect(requestTopicSearch('   ', 1, fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps 403 disabled to the local-filter fallback', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 403,
      ok: false,
      json: async () => ({ ok: false, error: 'disabled' }),
    })) as unknown as typeof fetch;

    const action = await requestTopicSearch('needle', 7, fetchImpl);
    expect(action).toEqual({ type: 'failure', query: 'needle', requestId: 7, disabled: true });

    const state = apply(
      apply(initialTopicSearchState, { type: 'start', query: 'needle', requestId: 7 }),
      action!,
    );
    expect(state.status).toBe('disabled');
    // Disabled = feature off: the original local substring filter still applies.
    expect(effectiveSessionSearchQuery('Needle', state)).toBe('needle');
  });

  it('maps server / auth / network failures to a retryable error and local fallback', async () => {
    const server = vi.fn(async () => ({
      status: 503,
      ok: false,
      json: async () => ({ ok: false, error: 'unavailable' }),
    })) as unknown as typeof fetch;
    expect(await requestTopicSearch('needle', 3, server)).toMatchObject({
      type: 'failure', disabled: false,
    });

    // A 401 gate returns HTML: response.json() rejects.
    const unauthorized = vi.fn(async () => ({
      status: 401,
      ok: false,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })) as unknown as typeof fetch;
    const authAction = await requestTopicSearch('needle', 4, unauthorized);
    expect(authAction).toMatchObject({ type: 'failure', disabled: false });

    const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const networkAction = await requestTopicSearch('needle', 5, offline);
    expect(networkAction).toMatchObject({ type: 'failure', disabled: false });

    const state = apply(
      apply(initialTopicSearchState, { type: 'start', query: 'needle', requestId: 4 }),
      authAction!,
    );
    expect(state.status).toBe('error');
    expect(effectiveSessionSearchQuery('Needle', state)).toBe('needle');
  });

  it('applies a successful response and drops the local substring filter', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        generatedAt: '2026-01-01T00:00:00.000Z',
        items: [hit({ topicKey: 'thread:oc:om_1', title: 'Persistent topic' })],
        effectiveMode: 'keyword',
        degradedReasons: ['vectors_missing'],
        coverage: { state: 'partial', unindexedKnownTopics: 2 },
        nextCursor: null,
      }),
    })) as unknown as typeof fetch;

    const action = await requestTopicSearch('needle', 6, fetchImpl);
    expect(action).toMatchObject({
      type: 'success',
      query: 'needle',
      requestId: 6,
      items: [{ topicKey: 'thread:oc:om_1', title: 'Persistent topic' }],
      coverage: { state: 'partial', unindexedKnownTopics: 2 },
      degradedReasons: ['vectors_missing'],
    });

    const state = apply(
      apply(initialTopicSearchState, { type: 'start', query: 'needle', requestId: 6 }),
      action!,
    );
    expect(state.status).toBe('ready');
    // Content search owns the result set: no second substring pass.
    expect(effectiveSessionSearchQuery('needle', state)).toBe('');
    // A blank query always keeps the original local behaviour.
    expect(effectiveSessionSearchQuery('  ', state)).toBe('');
  });
});

describe('topic content search results view', () => {
  it('orders topic groups by the search hits, not by latest activity', () => {
    const first = row('first', 'om_first', { lastMessageAt: 900 });
    const second = row('second', 'om_second', { lastMessageAt: 100 });
    const firstKey = sessionTopicKey(first);
    const secondKey = sessionTopicKey(second);

    const html = renderTopics({
      rows: [first, second],
      relationRows: [first, second],
      search: readyState([
        hit({ topicKey: secondKey, title: 'second topic' }),
        hit({ topicKey: firstKey, title: 'first topic' }),
      ]),
    });

    expect(html.indexOf(`data-topic-key="${secondKey}"`))
      .toBeLessThan(html.indexOf(`data-topic-key="${firstKey}"`));
    expect(html).toContain('summary for ' + secondKey);
    expect(html).toContain(t('sessions.topic.updatedAt'));
    // Local substring filtering is not applied on top of the search result.
    expect(html).not.toContain('sessions.topic.searchEmpty');
  });

  it('renders a search hit that has no session rows without inventing a card', () => {
    const topicKey = 'thread:oc_archived:om_archived';
    const item = hit({
      topicKey,
      title: 'Archived topic title',
      url: 'https://example.test/topic/1',
      matches: [{
        summaryId: 'summary-1',
        text: 'the matched summary body',
        sourceMessageIds: ['om_source_1'],
      }],
    });

    const html = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([item]),
    });

    expect(html).toContain(`data-topic-key="${topicKey}"`);
    expect(html).toContain('data-search-only="true"');
    expect(html).toContain('Archived topic title');
    expect(html).toContain('the matched summary body');
    expect(html).toContain('data-search-entry="url"');
    expect(html).toContain('href="https://example.test/topic/1"');
    // Critically: no fabricated session row for the persistent topic.
    expect(html).not.toContain('<article class="session-card');
  });

  it('falls back to the first session details when a hit has no url, and never fabricates one', () => {
    const onlyRow = row('only', 'om_only', { title: 'topic with a session' });
    const topicKey = sessionTopicKey(onlyRow);

    const withRow = renderTopics({
      rows: [onlyRow],
      relationRows: [onlyRow],
      search: readyState([hit({ topicKey, title: 'topic with a session', url: undefined })]),
    });
    expect(withRow).toContain('data-search-entry="details"');
    expect(withRow).toContain(`>${t('sessions.details')}<`);
    expect(withRow).not.toContain('href="http');

    const withoutRow = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([hit({ topicKey: 'thread:oc_none:om_none', url: undefined })]),
    });
    expect(withoutRow).not.toContain('data-search-entry');
    expect(withoutRow).not.toContain('href="http');
  });

  it('keeps status / Bot filters authoritative for hits that still have session rows', () => {
    // The status filter removed this closed session upstream, so `rows` is
    // empty while the full store still knows the topic.
    const filteredOut = row('closed', 'om_closed', {
      status: 'closed',
      title: 'a filtered-out topic',
    });
    const topicKey = sessionTopicKey(filteredOut);

    const html = renderTopics({
      rows: [],
      relationRows: [filteredOut],
      search: readyState([hit({ topicKey, title: 'a filtered-out topic' })]),
    });

    expect(html).not.toContain('a filtered-out topic');
    expect(html).not.toContain('data-search-only="true"');
  });

  it('surfaces partial coverage and degraded reasons', () => {
    const html = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState(
        [hit({ topicKey: 'thread:oc:om_partial', title: 'partial topic' })],
        {
          coverage: { state: 'partial', unindexedKnownTopics: 4 },
          degradedReasons: ['vectors_missing'],
        },
      ),
    });

    expect(html).toContain('data-search-coverage="partial"');
    expect(html).toContain(t('sessions.topic.partial', { count: 4 }));
    expect(html).toContain(t('sessions.topic.degraded'));
  });

  it('marks per-hit degradation and empty results', () => {
    const degraded = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([hit({
        topicKey: 'thread:oc:om_degraded',
        title: 'degraded topic',
        degraded: ['not_indexed'],
      })]),
    });
    expect(degraded).toContain('data-search-degraded="item"');

    const empty = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([]),
    });
    expect(empty).toContain(t('sessions.topic.searchEmpty'));
  });

  it('shows LoadingState while searching and a retry entry after failure', () => {
    const loading = renderTopics({
      rows: [],
      relationRows: [],
      search: { ...initialTopicSearchState, status: 'loading', query: 'needle', requestId: 1 },
    });
    expect(loading).toContain('class="page-loading');
    expect(loading).toContain(t('sessions.topic.searching'));

    const failed = renderTopics({
      rows: [],
      relationRows: [],
      search: { ...initialTopicSearchState, status: 'error', query: 'needle', requestId: 1 },
      onSearchRetry: () => {},
    });
    expect(failed).toContain('sessions-topic-search-retry');
    expect(failed).toContain(t('sessions.topic.searchFailed'));
    expect(failed).toContain(t('sessions.topic.searchRetry'));
  });

  it('keeps the original local list when there is no query or no search state', () => {
    const onlyRow = row('solo', 'om_solo', { title: 'local list topic' });
    const html = renderTopics({ rows: [onlyRow] });

    expect(html).toContain('local list topic');
    expect(html).toContain(t('sessions.topic.sessions', { count: 1 }));
    // Default (no search prop) rendering is unchanged: no search chrome.
    expect(html).not.toContain('data-search-hit');
    expect(html).not.toContain('sessions-topic-search-state');
    expect(effectiveSessionSearchQuery('', readyState([]))).toBe('');
  });
});
