/** Offline visual fixture using production React components/CSS; no dashboard server or user profile. */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { TopicGroupsView } from '../src/dashboard/web/sessions-page.js';
import { TopicSearchControls, type TopicSearchUi } from '../src/dashboard/web/topic-search-ui.js';
import type { TopicSearchItem } from '../src/topic/search.js';

const directory = resolve(process.argv[2] ?? '/tmp/astra-topic-offline/screenshots');
mkdirSync(directory, { recursive: true });
const items: TopicSearchItem[] = [
  { topicKey: 'thread:oc_fixture:om_current', chatId: 'oc_fixture', title: '跨应用 owner 身份转换', url: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_fixture&open_thread_id=omt_fixture',
    matches: [{ summaryId: 's1', text: 'open_id 只在签发它的应用内有效。创建新机器人时，使用邮箱或 union_id 在目标应用中重新解析 owner；不能复制来源应用的 open_id。', sourceMessageIds: ['om_fixture_1', 'om_fixture_2'] }], updatedAt: '2026-10-29T08:30:00Z', topicCreatedAt: '2026-10-20T02:00:00Z', latestMessageAt: '2026-10-29T08:00:00Z', sourceThroughAt: '2026-10-29T08:00:00Z' },
  { topicKey: 'thread:oc_fixture:om_archive', chatId: 'oc_fixture', title: '历史话题：授权边界与错误码', url: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_fixture&open_thread_id=omt_archive',
    matches: [{ summaryId: 's2', text: '出现 E_OWNER_SCOPE 时先核对应用身份。会话关闭后保留已生成的摘要，群移出更新范围不影响历史检索。', sourceMessageIds: ['om_fixture_archive'] }], updatedAt: '2026-10-27T04:00:00Z', latestMessageAt: '2026-10-27T03:00:00Z', sourceThroughAt: '2026-10-27T03:00:00Z' },
];
const noop = () => {};
const rows = [{ sessionId: 'fixture-session', chatId: 'oc_fixture', rootMessageId: 'om_current', title: '跨应用 owner 身份转换', status: 'running', cliId: 'codex', botName: '开发助手', cwd: '/fixture/project', lastMessageAt: Date.parse('2026-10-29T08:00:00Z'), spawnedAt: Date.parse('2026-10-20T02:00:00Z') }];
const search: TopicSearchUi = { active: true, enabled: true, statusError: false, basis: 'latestMessage', setBasis: noop, from: '2026-10-01T00:00', setFrom: noop, to: '', setTo: noop, mode: 'auto', setMode: noop, loading: false, error: null, retry: () => undefined, more: () => undefined,
  result: { items, nextCursor: null, effectiveMode: 'keyword', degradedReasons: ['embedding_disabled'], coverage: { state: 'partial', unindexedKnownTopics: 3, examinedTopics: 20, unknownDateTopics: 1, budgetLimited: false } } };
const markup = renderToStaticMarkup(createElement('main', {}, createElement('section', { className: 'page sessions-page' },
  createElement('h1', {}, '话题 · 内容检索'), createElement('p', {}, '离线合成数据 · 查询：跨应用 owner'),
  createElement(TopicSearchControls, { search }),
  createElement(TopicGroupsView, { rows, relationRows: rows, searchItems: items, selected: new Set<string>(), hidden: false, onToggleSelect: noop, onOpen: noop, onHistory: noop, onLocate: async () => false, onRestart: noop, onLock: noop, onClose: noop }),
)));
const css = readFileSync(resolve('src/dashboard/web/style.css'), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.TOPIC_SCREENSHOT_BROWSER || undefined, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
try {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: { width: 1365, height: 1000 } });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><style>${css}</style><style>html,body{overflow:auto;height:auto}main{padding:24px;overflow:visible;width:100%;min-width:0;box-sizing:border-box}.page{max-width:1280px;width:100%;box-sizing:border-box;margin:auto}.sessions-topic-view{height:auto;overflow:visible}.session-topic-members{max-width:100%}body{font-family:system-ui,sans-serif}</style><body>${markup}</body></html>`);
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true, animations: 'disabled' });
  console.log(JSON.stringify({ directory, desktopOverflow, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), network: 'offline context; all requests aborted; fresh profile' }));
  await context.close();
} finally { await browser.close(); }
