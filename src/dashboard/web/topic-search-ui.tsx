import { useEffect, useRef, useState } from 'react';
import type { TopicSearchItem } from '../../topic/search.js';
import { TopicSearchController, safeTopicLink, topicSearchRequest, type TopicSearchState } from './topic-search-controller.js';

export function useTopicSearch(visible: boolean, query: string, chat: string) {
  const [enabled, setEnabled] = useState(false);
  const [basis, setBasis] = useState<'topicCreated' | 'latestMessage'>('latestMessage');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [mode, setMode] = useState<'auto' | 'keyword' | 'hybrid'>('auto');
  const [state, setState] = useState<TopicSearchState>({ result: null, loading: false, error: null });
  const [statusError, setStatusError] = useState(false);
  const controller = useRef<TopicSearchController | null>(null);
  if (!controller.current) controller.current = new TopicSearchController((...args) => fetch(...args), setState);
  const active = visible && enabled && !!(query.trim() || from || to);
  const requestKey = JSON.stringify([query, chat, basis, from, to, mode]);
  const [resultKey, setResultKey] = useState('');

  useEffect(() => {
    if (!visible) return;
    let disposed = false; const abort = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch('/api/topic-search/status', { signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const status = await response.json() as { enabled?: boolean };
        if (!disposed) { setEnabled(status.enabled === true); setStatusError(false); }
      } catch { if (!disposed) setStatusError(true); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 15_000);
    return () => { disposed = true; abort.abort(); clearInterval(timer); };
  }, [visible]);

  useEffect(() => {
    controller.current!.reset();
    if (!active) return;
    const timer = setTimeout(() => {
      setResultKey(requestKey);
      try { void controller.current!.search(topicSearchRequest(query, chat, basis, from, to, mode)); }
      catch { setState({ result: null, loading: false, error: 'invalid_date' }); }
    }, 250);
    return () => { clearTimeout(timer); controller.current!.reset(); };
  }, [active, requestKey]);
  useEffect(() => { if (state.error === 'disabled') setEnabled(false); }, [state.error]);
  const current = resultKey === requestKey ? state : { result: null, loading: active, error: null };
  return { active, enabled, statusError, basis, setBasis, from, setFrom, to, setTo, mode, setMode, ...current,
    retry: () => void controller.current!.retry(), more: () => void controller.current!.more() };
}
export type TopicSearchUi = ReturnType<typeof useTopicSearch>;

export function TopicSearchControls({ search }: { search: TopicSearchUi }) {
  return <section className="topic-content-search" aria-label="话题内容检索">
    <div className="topic-search-controls">
      <strong>话题内容检索</strong>
      {!search.enabled ? <span>{search.statusError ? '检索状态暂不可用，当前使用原列表' : '未启用，当前使用原列表'}</span> : <>
        <label>日期口径 <select aria-label="日期口径" value={search.basis} onChange={event => search.setBasis(event.currentTarget.value as TopicSearchUi['basis'])}>
          <option value="latestMessage">最新消息时间</option><option value="topicCreated">话题创建时间</option>
        </select></label>
        <label>从 <input aria-label="起始时间" type="datetime-local" value={search.from} onChange={event => search.setFrom(event.currentTarget.value)} /></label>
        <label>至 <input aria-label="结束时间" type="datetime-local" value={search.to} onChange={event => search.setTo(event.currentTarget.value)} /></label>
        <label>检索方式 <select aria-label="检索方式" value={search.mode} onChange={event => search.setMode(event.currentTarget.value as TopicSearchUi['mode'])}>
          <option value="auto">自动</option><option value="keyword">关键词</option><option value="hybrid">混合</option>
        </select></label>
        {search.from || search.to ? <button type="button" onClick={() => { search.setFrom(''); search.setTo(''); }}>清除日期</button> : null}
      </>}
    </div>
    {search.enabled ? <small>使用上方搜索框查询摘要和关键词；也可留空，仅按日期查询。日期按浏览器本地时区输入。</small> : null}
    {search.active ? <div className="topic-search-feedback" aria-live="polite">
      {search.loading ? <span role="status">正在检索…</span> : null}
      {search.error ? <span role="alert">{search.error === 'cursor_expired' ? '索引已更新或分页已过期，请重新查询。' : search.error === 'invalid_date' ? '请选择有效日期。' : '检索暂不可用。'} <button type="button" onClick={search.retry}>重试</button></span> : null}
      {search.result ? <>
        <span>{search.result.items.length} 个话题 · {search.result.effectiveMode === 'hybrid' ? '混合检索' : '关键词检索'}</span>
        {search.result.coverage.state === 'partial' ? <span className="topic-chip">部分覆盖：仅当前部署已知话题；未完成索引 {search.result.coverage.unindexedKnownTopics} 个</span> : <span>当前已知目录已覆盖</span>}
        {search.result.coverage.unknownDateTopics ? <span>来源日期未知 {search.result.coverage.unknownDateTopics} 个</span> : null}
        {search.result.coverage.budgetLimited ? <span>已达到查询预算，可缩小范围后重试</span> : null}
        {search.result.degradedReasons.length ? <span>向量不可用或未齐备，已保留关键词结果</span> : null}
      </> : null}
    </div> : null}
  </section>;
}

export function TopicResultDetails({ item, historical }: { item: TopicSearchItem; historical?: boolean }) {
  const href = safeTopicLink(item.url);
  const date = (value: string | undefined) => value ? new Date(value).toLocaleString() : '未知';
  return <div className="topic-result-details">
    <div className="topic-result-meta">
      {historical ? <span className="topic-chip">历史话题 · 无现存会话</span> : null}
      {href ? <a href={href} target="_blank" rel="noopener noreferrer">打开话题</a> : null}
      <span>话题创建：{date(item.topicCreatedAt)}</span><span>最新消息：{date(item.latestMessageAt)}</span>
      <span>摘要覆盖至：{date(item.sourceThroughAt)}</span><span>摘要更新：{date(item.updatedAt)}</span>
    </div>
    {item.matches.map(match => <article key={match.summaryId} className="topic-summary-match">
      <p>{match.text}</p><small>来源消息：{match.sourceMessageIds.map(id => <code key={id}>{id}</code>)}</small>
    </article>)}
    {!item.matches.length ? <small>标题或日期命中；暂无命中摘要。</small> : null}
  </div>;
}
