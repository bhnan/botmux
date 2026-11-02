import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TopicStore } from '../../src/topic/store.js';
import { TopicScheduler } from '../../src/topic/scheduler.js';
import { topicSummaryExecutor } from '../../src/topic/summary-updater.js';
import { parseTopicSearchConfig, type TopicSearchConfig } from '../../src/topic/config.js';
import { decodeCursor, type TopicMessage } from '../../src/topic/source.js';
import type { TopicModelInput } from '../../src/topic/model-client.js';

let directory: string, store: TopicStore, runtime: TopicScheduler, config: TopicSearchConfig, now: number, slot: number;
let sourceMessages: TopicMessage[], page: ReturnType<typeof vi.fn>, model: ReturnType<typeof vi.fn>;
const key = 'thread:oc_a:om_root';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'topic-updater-')); now = Date.parse('2026-10-02T00:00:00Z'); slot = 1;
  store = new TopicStore(join(directory, 'topics.db'), () => now);
  store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: '讨论', accessPolicyRef: 'dashboard' }, new Date(now).toISOString());
  config = parseTopicSearchConfig({ enabled: true, allowedChatIds: ['oc_a'], llmModelRef: 'test', models: { test: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST' } }, maxMessagesPerBatch: 7 });
  sourceMessages = [{ id: 'om_root', text: 'A changed to B', createdAt: '2026-10-01T00:00:00.000Z' }];
  page = vi.fn(async (token?: string) => {
    const start = Number(token ?? 0), end = start + 50;
    return { messages: sourceMessages.slice(start, end), hasMore: end < sourceMessages.length, nextToken: end < sourceMessages.length ? String(end) : undefined, verifiedThread: true, topicCreatedAt: sourceMessages[0].createdAt };
  });
  model = vi.fn(async (_profile, input: TopicModelInput) => [{ op: 'add', text: input.messages.map(m => m.text).join(';'), keywords: ['fact'], sourceMessageIds: input.messages.map(m => m.id) }]);
  const execute = topicSummaryExecutor({ store, source: () => page, model: { summarize: model }, now: () => now });
  runtime = new TopicScheduler(store, () => ({ ...config, slot: String(slot), snapshot: JSON.stringify(config) }), execute);
});
afterEach(async () => { await runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
async function tick() { runtime.tick(); await runtime.idle(); }
it('runs real store/scheduler/updater from source through structured summary and atomically acknowledges it', async () => {
  await tick();
  const topic = store.read(key)!;
  expect(topic.summaries).toHaveLength(1);
  expect(topic.summaries[0]).toMatchObject({ text: 'A changed to B', keywords: ['fact'], sourceMessageIds: ['om_root'] });
  expect(decodeCursor(topic.summarizedThroughCursor!).ids).toEqual(['om_root']);
  expect(topic.topicCreatedAt).toBe(sourceMessages[0].createdAt);
  expect(store.jobs.list()[0].state).toBe('done');
});
it('with no increment it checks history but makes no additional summary/model call', async () => {
  await tick(); slot++; await tick();
  expect(page).toHaveBeenCalledTimes(2); expect(model).toHaveBeenCalledTimes(1);
  expect(store.read(key)!.summaries).toHaveLength(1);
});
it('a failed model still records source latest time and preserves the last successful cursor', async () => {
  await tick(); const cursor = store.read(key)!.summarizedThroughCursor;
  sourceMessages.push({ id: 'om_new', text: 'new fact', createdAt: '2026-10-02T00:00:00.000Z' });
  model.mockRejectedValue(new Error('topic_model_http_failed')); slot++; await tick();
  expect(store.read(key)!.latestMessageAt).toBe(sourceMessages[1].createdAt);
  expect(store.read(key)!.summarizedThroughCursor).toBe(cursor);
  expect(store.jobs.list()[1].state).toBe('queued');
});
it('persists exact remainder across batch/clock changes so larger-than-page same-ms backlog has no holes', async () => {
  sourceMessages = Array.from({ length: 115 }, (_, i) => ({ id: `om_${i}`, text: `fact ${i}`, createdAt: '2026-10-01T00:00:00.000Z' }));
  const seen: string[] = [];
  model.mockImplementation(async (_profile, input: TopicModelInput) => { seen.push(...input.messages.map(m => m.id)); return [{ op: 'noop' }]; });
  for (let i = 0; i < 17; i++) { await tick(); slot++; now += 1000; }
  expect(seen).toEqual(sourceMessages.map(m => m.id));
  expect(page).toHaveBeenCalledTimes(3);
  expect(decodeCursor(store.read(key)!.summarizedThroughCursor!).ids).toHaveLength(115);
  expect(store.sourceCheckpoint(key)).toBeNull();
});
it('known deletion invalidates previously indexed evidence and skips unnecessary model calls', async () => {
  await tick(); sourceMessages[0] = { ...sourceMessages[0], text: '', deleted: true }; slot++; await tick();
  expect(store.read(key)!.summaries).toEqual([]);
  expect(model).toHaveBeenCalledTimes(1);
});
it('concurrent topic revision changes reject a valid but stale result rather than overwriting it', async () => {
  model.mockImplementation(async () => {
    store.discover({ chatId: 'oc_a', rootMessageId: 'om_root', title: 'renamed', accessPolicyRef: 'dashboard' }, new Date(now).toISOString());
    return [{ op: 'add', text: 'late', keywords: [], sourceMessageIds: ['om_root'] }];
  });
  await tick();
  expect(store.read(key)!.title).toBe('renamed');
  expect(store.read(key)!.summaries).toEqual([]);
  expect(store.read(key)!.summarizedThroughCursor).toBeUndefined();
  expect(store.jobs.list()[0]).toMatchObject({ state: 'queued', error: 'topic_revision_conflict' });
});
