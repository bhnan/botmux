import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopicSearchController, topicSearchGroups, topicContentRows, topicSearchRequest, safeTopicLink, topicSourceLink } from '../../src/dashboard/web/topic-search-controller.js';
import { TopicResultDetails } from '../../src/dashboard/web/topic-search-ui.js';
import { TopicGroupsView } from '../../src/dashboard/web/sessions-page.js';
import type { TopicSearchItem, TopicSearchResponse } from '../../src/topic/search.js';

function item(id: string): TopicSearchItem { return { topicKey: `thread:oc_a:om_${id}`, chatId: 'oc_a', title: `Discussion ${id}`, url: `https://applink.feishu.cn/client/thread/open?open_chat_id=oc_a&open_thread_id=omt_${id}`, matches: [{ summaryId: id, text: 'source-only searchable fact', sourceMessageIds: ['om_source'] }], updatedAt: '2026-10-01T00:00:00Z' }; }
function response(items: TopicSearchItem[], nextCursor: string | null = null): TopicSearchResponse { return { items, nextCursor, effectiveMode: 'keyword', degradedReasons: [], coverage: { state: 'partial', unindexedKnownTopics: 1, examinedTopics: 2, unknownDateTopics: 0, budgetLimited: false } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const request = (query = 'fact') => topicSearchRequest(query, '', 'latestMessage', '', '', 'keyword');

it('a slow previous response and error cannot overwrite a newer query', async () => {
  const old = deferred<Response>(), current = deferred<Response>();
  const transport = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const controller = new TopicSearchController(transport as typeof fetch, vi.fn());
  const one = controller.search(request('old')), two = controller.search(request('new'));
  current.resolve(new Response(JSON.stringify(response([item('new')])))); await two;
  old.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })); await one;
  expect(controller.state.result?.items[0].topicKey).toBe(item('new').topicKey);
  expect(controller.state.error).toBeNull();
});
it('clearing the query aborts pending transport and ignores a provider that still resolves', async () => {
  const old = deferred<Response>(), transport = vi.fn().mockReturnValue(old.promise);
  const controller = new TopicSearchController(transport as typeof fetch, vi.fn());
  const pending = controller.search(request()); controller.reset();
  expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  old.resolve(new Response(JSON.stringify(response([item('old')])))); await pending;
  expect(controller.state).toEqual({ result: null, loading: false, error: null });
});
it('appends pages in server order without duplicate topics and restarts after expired cursors', async () => {
  const transport = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(response([item('a')], 'cursor'))))
    .mockResolvedValueOnce(new Response(JSON.stringify(response([item('a'), item('b')], 'last'))))
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'topic_search_cursor_expired' }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(response([item('new')]))));
  const controller = new TopicSearchController(transport as typeof fetch, vi.fn());
  await controller.search(request()); await controller.more();
  expect(controller.state.result?.items.map(item => item.topicKey)).toEqual([item('a').topicKey, item('b').topicKey]);
  expect(JSON.parse(transport.mock.calls[1][1].body).cursor).toBe('cursor');
  await controller.more(); expect(controller.state.error).toBe('cursor_expired');
  await controller.retry(); expect(JSON.parse(transport.mock.calls[3][1].body).cursor).toBeNull();
  expect(controller.state.result?.items).toEqual([item('new')]);
});
it('server disable is surfaced separately so the page can restore its old list', async () => {
  const controller = new TopicSearchController(vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'topic_search_disabled' }), { status: 403 })) as typeof fetch, vi.fn());
  await controller.search(request()); expect(controller.state.error).toBe('disabled');
});
it('keeps original grouping when inactive, server ranking when active, and historical topics without fake sessions', () => {
  const rows = [{ sessionId: 'a', chatId: 'oc_a', rootMessageId: 'om_a', title: 'does not contain the content query', status: 'running' }, { sessionId: 'b', chatId: 'oc_a', rootMessageId: 'om_b', title: 'B', status: 'closed' }];
  expect(topicSearchGroups(rows, rows, undefined, true)).toHaveLength(2);
  const result = topicSearchGroups(rows, rows, [item('b'), item('historical'), item('a')], true);
  expect(result.map(group => group.key)).toEqual([item('b').topicKey, item('historical').topicKey, item('a').topicKey]);
  expect(result[1].rows).toEqual([]);
  // A currently filtered existing topic must not reappear as a synthetic historical result.
  expect(topicSearchGroups([rows[0]], rows, [item('b'), item('historical'), item('a')], false).map(group => group.key)).toEqual([item('a').topicKey]);
});
it('date-only requests choose one explicit basis and carry timezone-bearing values', () => {
  const result = topicSearchRequest('', 'oc_a', 'topicCreated', '2026-10-01T00:00', '', 'keyword');
  expect(result.query).toBe(''); expect(result.filters.timeBasis).toBe('topicCreated'); expect(result.filters.from).toMatch(/Z$/); expect(result.filters.to).toBeNull();
});
it('renders historical source matches and unknown dates as text, never executable source HTML/links', () => {
  const result = item('historic'); result.matches[0].text = '<script>steal()</script>'; result.url = 'javascript:steal()';
  const html = renderToStaticMarkup(createElement(TopicResultDetails, { item: result, historical: true }));
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('javascript:');
  expect(html).toContain('om_source'); expect(safeTopicLink('https://evil.invalid/client/thread/open')).toBeUndefined();
});
it('the real topic view renders matched source text and keeps existing member cards plus historical rows', () => {
  const row = { sessionId: 's', chatId: 'oc_a', rootMessageId: 'om_a', title: 'plain title', status: 'running', cliId: 'codex', lastMessageAt: 1, cwd: '/fixture' };
  const noop = () => {};
  const html = renderToStaticMarkup(createElement(TopicGroupsView, { rows: [row], relationRows: [row], searchItems: [item('a'), item('historical')], selected: new Set(), hidden: false,
    onToggleSelect: noop, onOpen: noop, onHistory: noop, onLocate: async () => false, onRestart: noop, onLock: noop, onClose: noop }));
  expect(html).toContain('source-only searchable fact'); expect(html).toContain('data-topic-key="thread:oc_a:om_historical"');
  expect(html).toContain('plain title'); expect(html).toContain('session-topic-members');
});

it('bulk-selection candidates exclude every topic hidden by content results, including while loading', () => {
  const rows = [{ sessionId: 'matched', chatId: 'oc_a', rootMessageId: 'om_a' }, { sessionId: 'hidden', chatId: 'oc_a', rootMessageId: 'om_b' }];
  expect(topicContentRows(rows, [item('a')]).map(row => row.sessionId)).toEqual(['matched']);
  expect(topicContentRows(rows, [])).toEqual([]);
  expect(topicContentRows(rows, undefined)).toEqual(rows);
});

it('real summary citations navigate to the authenticated source handler, without external URL interpolation', () => {
  const result = item('a'), tree = TopicResultDetails({ item: result });
  const links: string[] = [];
  const walk = (node: any): void => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { if (node.type === 'a') links.push(node.props.href); walk(node.props?.children); } };
  walk(tree);
  const source = links.find(link => link.startsWith('/api/topic-search/source?'))!;
  expect(source).toBeDefined();
  const url = new URL(source, 'https://dashboard.invalid');
  expect(url.searchParams.get('messageId')).toBe('om_source'); expect(url.searchParams.get('topicKey')).toBe(result.topicKey);
  expect(topicSourceLink(result.topicKey, 'javascript:alert(1)')).toBeUndefined();
  expect(topicSourceLink('https://evil.invalid', 'om_source')).toBeUndefined();
});
