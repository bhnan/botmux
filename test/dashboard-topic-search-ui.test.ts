import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TopicGroupsView,
  effectiveSessionSearchQuery,
  initialTopicSearchState,
  requestTopicSearch,
  topicSearchReducer,
  topicTimeFilterIssue,
  topicTimeFilterKey,
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
      nextCursor: null,
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
      nextCursor: null,
    });
    expect(applied.status).toBe('ready');
    expect(applied.items.map(item => item.topicKey)).toEqual(['thread:oc:om_second']);
  });

  it('short-circuits a blank query before touching the network', async () => {
    const fetchImpl = vi.fn();
    await expect(requestTopicSearch('   ', 1, { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps 403 disabled to the local-filter fallback', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 403,
      ok: false,
      json: async () => ({ ok: false, error: 'disabled' }),
    })) as unknown as typeof fetch;

    const action = await requestTopicSearch('needle', 7, { fetchImpl });
    expect(action).toEqual({ type: 'failure', query: 'needle', timeFilterKey: '', requestId: 7, disabled: true });

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
    expect(await requestTopicSearch('needle', 3, { fetchImpl: server })).toMatchObject({
      type: 'failure', disabled: false,
    });

    // A 401 gate returns HTML: response.json() rejects.
    const unauthorized = vi.fn(async () => ({
      status: 401,
      ok: false,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })) as unknown as typeof fetch;
    const authAction = await requestTopicSearch('needle', 4, { fetchImpl: unauthorized });
    expect(authAction).toMatchObject({ type: 'failure', disabled: false });

    const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const networkAction = await requestTopicSearch('needle', 5, { fetchImpl: offline });
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

    const action = await requestTopicSearch('needle', 6, { fetchImpl });
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

  it('pages through results with the server cursor and appends without duplicates', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { cursor?: string };
      const page = body.cursor
        ? {
          items: [hit({ topicKey: 'thread:oc:om_2' }), hit({ topicKey: 'thread:oc:om_3' })],
          nextCursor: null,
        }
        : {
          items: [hit({ topicKey: 'thread:oc:om_1' }), hit({ topicKey: 'thread:oc:om_2' })],
          nextCursor: 'cursor-2',
        };
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          effectiveMode: 'keyword',
          coverage: { state: 'complete', unindexedKnownTopics: 0 },
          degradedReasons: [],
          ...page,
        }),
      };
    }) as unknown as typeof fetch;

    let state = apply(initialTopicSearchState, { type: 'start', query: 'needle', requestId: 9 });
    const first = await requestTopicSearch('needle', 9, { fetchImpl });
    state = apply(state, first!);
    expect(state.items.map(item => item.topicKey)).toEqual([
      'thread:oc:om_1',
      'thread:oc:om_2',
    ]);
    expect(state.nextCursor).toBe('cursor-2');
    expect(JSON.parse(String((fetchImpl as any).mock.calls[0][1].body)).cursor).toBeUndefined();

    state = apply(state, { type: 'moreStart', query: 'needle', requestId: 9 });
    expect(state.loadingMore).toBe(true);
    const second = await requestTopicSearch('needle', 9, { cursor: 'cursor-2', fetchImpl });
    state = apply(state, second!);
    // The duplicate om_2 arrives again on page 2 and must not render twice.
    expect(state.items.map(item => item.topicKey)).toEqual([
      'thread:oc:om_1',
      'thread:oc:om_2',
      'thread:oc:om_3',
    ]);
    expect(state.nextCursor).toBeNull();
    expect(state.loadingMore).toBe(false);
    expect(JSON.parse(String((fetchImpl as any).mock.calls[1][1].body)).cursor).toBe('cursor-2');
  });

  it('ignores an appended page after the query has been replaced', () => {
    let state = readyState([hit({ topicKey: 'thread:oc:om_old' })], { nextCursor: 'cursor-2' });
    state = apply(state, { type: 'start', query: 'new query', requestId: 2 });
    const stale = apply(state, {
      type: 'moreSuccess',
      query: 'needle',
      requestId: 1,
      items: [hit({ topicKey: 'thread:oc:om_stale_page' })],
      coverage: { state: 'complete', unindexedKnownTopics: 0 },
      degradedReasons: [],
      nextCursor: null,
    });
    expect(stale).toBe(state);
  });

  it('keeps the current page when loading more fails and allows a retry', () => {
    let state = readyState([hit({ topicKey: 'thread:oc:om_1' })], { nextCursor: 'cursor-2' });
    state = apply(state, { type: 'moreStart', query: 'needle', requestId: 1 });
    state = apply(state, { type: 'moreFailure', query: 'needle', requestId: 1 });
    expect(state.loadMoreFailed).toBe(true);
    expect(state.loadingMore).toBe(false);
    expect(state.items.map(item => item.topicKey)).toEqual(['thread:oc:om_1']);
    expect(state.nextCursor).toBe('cursor-2');
  });

  it('日期筛选的界面校验不会静默丢弃已填写条件', () => {
    const base = { topicTimeField: '', topicTimeFrom: '', topicTimeTo: '' } as const;
    expect(topicTimeFilterIssue({ ...base } as never)).toBeNull();
    expect(topicTimeFilterIssue({ ...base, topicTimeField: 'created' } as never)).toBe('need_range');
    expect(topicTimeFilterIssue({ ...base, topicTimeFrom: '2026-10-01' } as never)).toBe('need_field');
    expect(topicTimeFilterIssue({
      ...base,
      topicTimeField: 'latestMessage',
      topicTimeFrom: '2026-10-05',
      topicTimeTo: '2026-10-01',
    } as never)).toBe('invalid_range');
    expect(topicTimeFilterIssue({
      ...base,
      topicTimeField: 'latestMessage',
      topicTimeFrom: '2026-10-01',
      topicTimeTo: '2026-10-03',
    } as never)).toBeNull();
  });

  it('纯日期筛选：空关键词也发请求，并携带 timeFilter 与独立 key', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        effectiveMode: 'keyword',
        coverage: { state: 'complete', unindexedKnownTopics: 0, unknownTimeTopics: 0 },
        degradedReasons: [],
        items: [hit({
          topicKey: 'thread:oc:om_1',
          topicCreatedAt: '2026-10-01T00:00:00.000Z',
          latestMessageAt: '2026-10-03T00:00:00.000Z',
          timeMetadata: 'synced',
        })],
        nextCursor: null,
      }),
    })) as unknown as typeof fetch;
    const timeFilter = {
      field: 'created' as const,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T23:59:59.999Z',
    };
    const action = await requestTopicSearch('', 21, { timeFilter, fetchImpl });
    const body = JSON.parse(String((fetchImpl as any).mock.calls[0][1].body));
    expect(body.query).toBe('');
    expect(body.timeFilter).toEqual(timeFilter);
    expect(action).toMatchObject({
      type: 'success',
      query: '',
      timeFilterKey: topicTimeFilterKey(timeFilter),
    });

    const state = apply(
      apply(initialTopicSearchState, {
        type: 'start',
        query: '',
        timeFilter,
        timeFilterKey: topicTimeFilterKey(timeFilter),
        requestId: 21,
      }),
      action!,
    );
    expect(state.status).toBe('ready');
    expect(state.items[0].latestMessageAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('时间口径切换后的旧响应不会污染新结果', () => {
    const filterA = { field: 'created' as const, from: '2026-10-01T00:00:00.000Z' };
    const filterB = { field: 'latestMessage' as const, from: '2026-10-01T00:00:00.000Z' };
    const state = apply(initialTopicSearchState, {
      type: 'start',
      query: '',
      timeFilter: filterB,
      timeFilterKey: topicTimeFilterKey(filterB),
      requestId: 22,
    });
    const stale = apply(state, {
      type: 'success',
      query: '',
      timeFilterKey: topicTimeFilterKey(filterA),
      requestId: 22,
      items: [hit({ topicKey: 'thread:oc:om_old' })],
      coverage: { state: 'complete', unindexedKnownTopics: 0, unknownTimeTopics: 0 },
      degradedReasons: [],
      nextCursor: null,
    });
    expect(stale).toBe(state);
  });

  it('sends the page chat filter and falls back to local filtering when it is outside the indexed scope', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 403,
      ok: false,
      json: async () => ({ ok: false, error: 'forbidden' }),
    })) as unknown as typeof fetch;

    const action = await requestTopicSearch('needle', 11, { chatId: 'oc_other', fetchImpl });
    expect(JSON.parse(String((fetchImpl as any).mock.calls[0][1].body)).filters)
      .toEqual({ chatIds: ['oc_other'] });
    expect(action).toEqual({ type: 'fallback', query: 'needle', timeFilterKey: '', requestId: 11 });

    const state = apply(
      apply(initialTopicSearchState, { type: 'start', query: 'needle', requestId: 11 }),
      action!,
    );
    expect(state.status).toBe('idle');
    // The scope refusal is not an error banner: the local substring filter is back.
    expect(effectiveSessionSearchQuery('Needle', state)).toBe('needle');
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

  it('展示话题创建/最新消息时间，并明确时间未同步数量', () => {
    const html = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState(
        [hit({
          topicKey: 'thread:oc:om_timed',
          title: 'timed topic',
          topicCreatedAt: '2026-10-01T00:00:00.000Z',
          latestMessageAt: '2026-10-03T00:00:00.000Z',
          timeMetadata: 'synced',
        })],
        { coverage: { state: 'partial', unindexedKnownTopics: 0, unknownTimeTopics: 2 } },
      ),
    });
    expect(html).toContain('data-search-created-at="2026-10-01T00:00:00.000Z"');
    expect(html).toContain('data-search-latest-at="2026-10-03T00:00:00.000Z"');
    expect(html).toContain(t('sessions.topic.timeCreated'));
    expect(html).toContain(t('sessions.topic.timeLatest'));
    expect(html).toContain(t('sessions.topic.timeUnknown', { count: 2 }));
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

  it('offers a load-more action only while the server reports another page', () => {
    const withCursor = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([hit({ topicKey: 'thread:oc:om_1' })], { nextCursor: 'cursor-2' }),
      onSearchMore: () => {},
    });
    expect(withCursor).toContain('data-search-more');
    expect(withCursor).toContain(t('sessions.topic.loadMore'));

    const lastPage = renderTopics({
      rows: [],
      relationRows: [],
      search: readyState([hit({ topicKey: 'thread:oc:om_1' })]),
    });
    expect(lastPage).not.toContain('data-search-more');
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
