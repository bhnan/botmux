/** Fresh offline Chromium; production React hook/controls; no HTTP server or live browser profile. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { TopicSearchItem, TopicSearchResponse } from '../src/topic/search.js';
import type {} from './topic-offline-ui-fixture.js';

const bundle = await build({ entryPoints: [resolve('scripts/topic-offline-ui-fixture.tsx')], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.TOPIC_SCREENSHOT_BROWSER || undefined, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
function item(id: string): TopicSearchItem { return { topicKey: `thread:oc_fixture:om_${id}`, chatId: 'oc_fixture', title: id, url: 'https://applink.feishu.cn/client/thread/open?open_chat_id=oc_fixture&open_thread_id=omt_fixture', updatedAt: '2026-10-01T00:00:00.000Z', matches: [{ summaryId: id, text: `Fixture ${id}`, sourceMessageIds: ['om_evidence'] }] }; }
function response(ids: string[], nextCursor: string | null = null): TopicSearchResponse { return { items: ids.map(item), nextCursor, effectiveMode: 'keyword', degradedReasons: [], coverage: { state: 'partial', unindexedKnownTopics: 1, examinedTopics: 3, unknownDateTopics: 0, budgetLimited: false } }; }
try {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });
  let networkAttempts = 0;
  await context.route('**/*', route => { networkAttempts++; return route.abort(); });
  const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.topicFixture?.state.enabled);
  assert.equal(await page.getByTestId('original-list').count(), 1);
  const request = async (index: number) => {
    await page.waitForFunction(i => window.topicFixture.requests.length > i, index);
    return page.evaluate(i => window.topicFixture.requests[i].body, index);
  };
  const reply = (index: number, body: unknown, status = 200) => page.evaluate(({ index, body, status }) => window.topicFixture.respond(index, body, status), { index, body, status });
  const ids = async (expected: string[]) => {
    await page.waitForFunction(wanted => JSON.stringify(window.topicFixture.state.ids) === JSON.stringify(wanted), expected.map(id => item(id).topicKey));
  };
  await page.getByLabel('起始时间').fill('2026-10-01T00:00');
  const dateOnly = await request(0);
  assert.equal(dateOnly.query, ''); assert.equal(dateOnly.filters?.timeBasis, 'latestMessage');
  assert.equal(dateOnly.filters?.from, '2026-09-30T16:00:00.000Z');
  await reply(0, response(['date'])); await ids(['date']);
  await page.getByLabel('日期口径').selectOption('topicCreated');
  assert.equal((await request(1)).filters?.timeBasis, 'topicCreated');
  await reply(1, response(['created'])); await ids(['created']);
  await page.getByLabel('fixture-query').fill('slow'); await request(2);
  await page.getByLabel('fixture-query').fill('new'); await request(3);
  assert.equal(await page.evaluate(() => window.topicFixture.requests[2].signal?.aborted), true);
  await reply(3, response(['new'], 'page-2')); await ids(['new']);
  await reply(2, response(['stale']));
  // Let both the old transport continuation and React render tasks finish; result must stay new.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.deepEqual(await page.evaluate(() => window.topicFixture.state.ids), [item('new').topicKey]);
  await page.getByTestId('more').click(); assert.equal((await request(4)).cursor, 'page-2');
  await reply(4, response(['new', 'more'], 'last')); await ids(['new', 'more']);
  await page.getByTestId('more').click(); await request(5);
  await reply(5, { error: 'topic_search_cursor_expired' }, 400);
  await page.waitForFunction(() => window.topicFixture.state.error === 'cursor_expired');
  await page.getByRole('alert').getByRole('button').click(); assert.equal((await request(6)).cursor, null);
  await reply(6, response(['retry'])); await ids(['retry']);
  const source = page.locator('a[href^="/api/topic-search/source?"]');
  assert.equal(await source.count(), 1);
  const url = new URL((await source.getAttribute('href'))!, 'https://fixture.invalid');
  assert.equal(url.searchParams.get('messageId'), 'om_evidence');
  await page.getByLabel('fixture-chat').fill('oc_fixture');
  assert.deepEqual((await request(7)).filters?.chatIds, ['oc_fixture']);
  await reply(7, response([])); await ids([]);
  await page.getByLabel('检索方式').selectOption('hybrid'); assert.equal((await request(8)).mode, 'hybrid');
  await reply(8, { error: 'temporary_failure' }, 503);
  await page.waitForFunction(() => window.topicFixture.state.error === 'unavailable');
  await page.getByRole('alert').getByRole('button').click(); await request(9);
  await reply(9, { error: 'topic_search_disabled' }, 403);
  await page.waitForFunction(() => !window.topicFixture.state.enabled && !window.topicFixture.state.active);
  assert.equal(await page.getByTestId('original-list').count(), 1);
  assert.equal(networkAttempts, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', scenarios: ['date-only/local-timezone', 'independent-date-basis', 'stale-response', 'pagination-dedup', 'expired-cursor-retry', 'source-anchor', 'chat-filter', 'mode/error/retry', 'disabled-fallback'], networkAttempts, transport: 'in-memory fake fetch', browser: 'fresh offline Chromium, no server/profile' }));
  await context.close();
} finally { await browser.close(); }
