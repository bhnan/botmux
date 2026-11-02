import { openDatabaseSyncOrThrow } from '../../src/services/sqlite-compat.js';
import { TOPIC_SOURCE_CHECKPOINT_TTL_MS } from '../../src/topic/source.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicRuntime } from '../../src/topic/runtime.js';
import { parseTopicSearchConfig, type TopicSearchConfig } from '../../src/topic/config.js';
import { TopicModelClient } from '../../src/topic/model-client.js';

let directory: string, config: TopicSearchConfig, rows: Array<Record<string, unknown>>, runtimes: TopicRuntime[], time: number;
let proxy: ReturnType<typeof vi.fn>, fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'topic-runtime-')); time = Date.parse('2026-10-02T00:00:00Z'); runtimes = [];
  config = parseTopicSearchConfig({ enabled: true, allowedChatIds: ['oc_a'], llmModelRef: 'summary', models: { summary: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' } } });
  rows = [{ chatId: 'oc_a', rootMessageId: 'om_root', larkThreadId: 'omt_a', sessionId: 's', title: 'discussion', larkAppId: 'app' }];
  proxy = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: 'om_root', text: 'owner fact', createdAt: '2026-10-01T00:00:00.000Z' }], hasMore: false, verifiedThread: true, topicCreatedAt: '2026-10-01T00:00:00.000Z' })));
  fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ mutations: [{ op: 'add', text: 'owner fact', keywords: ['owner'], sourceMessageIds: ['om_root'] }] }) } }] })));
});
afterEach(async () => { for (const runtime of runtimes) await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
function runtime() {
  const item = new TopicRuntime({ directory, config: () => config, sessions: () => rows, daemons: () => [{ larkAppId: 'app' }], proxy, now: () => time, model: new TopicModelClient({ fetch: fetcher as typeof fetch, credential: () => 'fake', now: () => time }) });
  runtimes.push(item); return item;
}
it('defaults off without creating a database, requesting sources or resolving model credentials', async () => {
  config = parseTopicSearchConfig(); const item = runtime(); item.tick(); await item.idle();
  expect(existsSync(join(directory, 'topics.sqlite'))).toBe(false); expect(proxy).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it('discovers deduplicated real threads and wires source -> independent model -> durable search', async () => {
  rows.push({ ...rows[0], sessionId: 's2' }, { ...rows[0], rootMessageId: 'virtual:pending' }, { ...rows[0], rootMessageId: 'om_chat', scope: 'chat' });
  const item = runtime(); item.tick(); await item.idle();
  const response = await item.service().search({ query: 'owner', mode: 'keyword' }, { principal: 'owner', chatIds: null });
  expect(response.items).toHaveLength(1); expect(response.items[0].title).toBe('discussion');
  expect(proxy).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(proxy.mock.calls[0][1]).toBe('/api/topic-source/page');
});
it('closed/absent sessions and removal from update scope do not erase historical search', async () => {
  const item = runtime(); item.tick(); await item.idle(); rows = []; config.allowedChatIds = []; time += 86_400_000;
  item.tick(); await item.idle(); item.tick(); await item.idle();
  expect((await item.service().search({ query: 'owner', mode: 'keyword' }, { principal: 'owner', chatIds: null })).items).toHaveLength(1);
  expect(proxy).toHaveBeenCalledTimes(1);
});
it('multiple Dashboard runtime instances share a deployment lease rather than calling the model twice', async () => {
  const one = runtime(), two = runtime(); one.tick(); two.tick(); await one.idle(); await two.idle();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(proxy).toHaveBeenCalledTimes(1);
});
it('retains the durable index over runtime shutdown and does not require reopening a Session', async () => {
  const first = runtime(); first.tick(); await first.idle(); await first.close(); rows = [];
  const next = runtime(); next.tick(); await next.idle();
  expect((await next.service().search({ query: 'owner', mode: 'keyword' }, { principal: 'owner', chatIds: null })).items).toHaveLength(1);
});
it('applies an explicit retention policy to retained content even when updates are disabled', async () => {
  const item = runtime(); item.tick(); await item.idle();
  rows = []; config.enabled = false; config.allowedChatIds = []; config.retentionDays = 1;
  time += 86_400_000;
  item.tick(); await item.idle();
  expect(proxy).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  config.enabled = true;
  expect((await item.service().search({ query: 'owner', mode: 'keyword' }, { principal: 'owner', chatIds: null })).items).toEqual([]);
});

it('disabled runtime purges expired raw checkpoints with no summary TTL and no source/model calls', async () => {
  config.maxMessagesPerBatch = 1; config.maxStepsPerTopic = 1;
  proxy.mockResolvedValue(new Response(JSON.stringify({ messages: [
    { id: 'om_root', text: 'owner fact', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'om_tail', text: 'temporary sensitive raw', createdAt: '2026-10-01T00:00:00.000Z' },
  ], hasMore: false, verifiedThread: true })));
  const item = runtime(); item.tick(); await item.idle();
  const db = openDatabaseSyncOrThrow(join(directory, 'topics.sqlite'));
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_source_scans').get()).toEqual({ n: 1 });
    config.enabled = false; config.allowedChatIds = []; time += TOPIC_SOURCE_CHECKPOINT_TTL_MS + 1;
    item.tick(); await item.idle();
    expect(db.prepare('SELECT COUNT(*) AS n FROM topic_source_scans').get()).toEqual({ n: 0 });
    expect(proxy).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { db.close(); }
});
it('source navigation resolves only still-cited messages through the verified source transport', async () => {
  const item = runtime(); item.tick(); await item.idle();
  const signal = new AbortController().signal, key = 'thread:oc_a:om_root';
  await expect(item.sourceView(key, 'om_arbitrary', signal)).rejects.toThrow('topic_source_not_referenced');
  expect(proxy).toHaveBeenCalledTimes(1);
  proxy.mockResolvedValue(new Response(JSON.stringify({ state: 'present', message: { id: 'om_root', text: 'current raw source', createdAt: '2026-10-01T00:00:00.000Z' } })));
  expect((await item.sourceView(key, 'om_root', signal)).message.text).toBe('current raw source');
  expect(proxy.mock.calls.at(-1)?.[1]).toBe('/api/topic-source/check');
  config.allowedChatIds = [];
  await expect(item.sourceView(key, 'om_root', signal)).rejects.toThrow('topic_source_scope_denied');
  expect(proxy).toHaveBeenCalledTimes(2);
});
it('source view does not leak a late response after scope removal and cancellation releases its bounded slot', async () => {
  const item = runtime(); item.tick(); await item.idle();
  let release!: (value: Response) => void;
  proxy.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
  const key = 'thread:oc_a:om_root', pending = item.sourceView(key, 'om_root', new AbortController().signal);
  config.allowedChatIds = [];
  release(new Response(JSON.stringify({ state: 'present', message: { id: 'om_root', text: 'late', createdAt: '2026-10-01T00:00:00.000Z' } })));
  await expect(pending).rejects.toThrow('topic_source_scope_denied');
  config.allowedChatIds = ['oc_a'];
  const abort = new AbortController(), cancelled = item.sourceView(key, 'om_root', abort.signal);
  abort.abort(); await expect(cancelled).rejects.toThrow('topic_source_unavailable');
  release(new Response(JSON.stringify({ state: 'unknown' })));
});

it('persists the verified source brand for historical topic navigation after its session disappears', async () => {
  proxy.mockResolvedValue(new Response(JSON.stringify({ sourceBrand: 'lark', nativeThreadId: 'omt_a', messages: [{ id: 'om_root', text: 'owner fact', createdAt: '2026-10-01T00:00:00.000Z' }], hasMore: false, verifiedThread: true })));
  const first = runtime(); first.tick(); await first.idle(); await first.close(); rows = [];
  const next = runtime(); next.tick(); await next.idle();
  const result = await next.service().search({ query: 'owner', mode: 'keyword' }, { principal: 'owner', chatIds: null });
  expect(new URL(result.items[0].url).hostname).toBe('applink.larksuite.com');
});
