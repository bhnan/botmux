/** Browser-only interaction fixture. Imports the production hook/controls, replaces transport only. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TopicSearchControls, TopicResultDetails, useTopicSearch } from '../src/dashboard/web/topic-search-ui.js';
import type { TopicSearchRequest } from '../src/topic/search.js';

interface Fixture {
  requests: Array<{ path: string; body: TopicSearchRequest; signal?: AbortSignal | null }>;
  respond(index: number, body: unknown, status?: number): void;
  state: { active: boolean; enabled: boolean; loading: boolean; error: string | null; ids: string[] };
}
declare global { interface Window { topicFixture: Fixture } }
const pending = new Map<number, (response: Response) => void>();
window.topicFixture = { requests: [], state: { active: false, enabled: false, loading: false, error: null, ids: [] },
  respond(index, body, status = 200) {
    const resolve = pending.get(index); if (!resolve) throw new Error('no_pending_fixture_request');
    pending.delete(index); resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  },
};
window.fetch = async (url, options) => {
  if (url === '/api/topic-search/status') return new Response(JSON.stringify({ enabled: true }));
  if (url !== '/api/topic-search' || options?.method !== 'POST') throw new Error('unexpected_fixture_transport');
  const index = window.topicFixture.requests.length;
  window.topicFixture.requests.push({ path: String(url), body: JSON.parse(String(options.body)), signal: options.signal });
  // Deliberately ignore cancellation to exercise the production generation fence.
  return new Promise<Response>(resolve => { pending.set(index, resolve); });
};
function App() {
  const [query, setQuery] = useState(''), [chat, setChat] = useState('');
  const search = useTopicSearch(true, query, chat);
  window.topicFixture.state = { active: search.active, enabled: search.enabled, loading: search.loading, error: search.error, ids: search.result?.items.map(item => item.topicKey) ?? [] };
  return <main>
    <input aria-label="fixture-query" value={query} onChange={e => setQuery(e.currentTarget.value)} />
    <input aria-label="fixture-chat" value={chat} onChange={e => setChat(e.currentTarget.value)} />
    <TopicSearchControls search={search} />
    {search.active ? <div data-testid="results">{search.result?.items.map(item => <TopicResultDetails key={item.topicKey} item={item} />)}</div> : <div data-testid="original-list">Original rows</div>}
    <button data-testid="more" disabled={search.loading || !search.result?.nextCursor} onClick={search.more}>More fixture</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
