import { expect, it, vi } from 'vitest';
import { readTopicIncrement, encodeCursor, decodeCursor, type TopicReadOptions, type TopicMessage, type TopicSourcePage } from '../../src/topic/source.js';

const start = '2026-10-01T00:00:00.000Z';
const message = (n: number, time = n): TopicMessage => ({ id: `om_${n}`, text: `message ${n}`, createdAt: new Date(Date.parse(start) + time).toISOString() });
function options(patch: Partial<TopicReadOptions> = {}): TopicReadOptions {
  return { coverageStartAt: start, now: start, maxPages: 2, maxMessages: 10, maxChars: 10_000, signal: new AbortController().signal, observe: vi.fn(), ...patch };
}
function pages(messages: TopicMessage[]) {
  return vi.fn(async (token?: string): Promise<TopicSourcePage> => {
    const offset = Number(token ?? 0), end = Math.min(messages.length, offset + 50);
    return { messages: messages.slice(offset, end), hasMore: end < messages.length, nextToken: end < messages.length ? String(end) : undefined, verifiedThread: true, topicCreatedAt: start };
  });
}
it('processes a backlog larger than both page and model limits without losing any message', async () => {
  const all = Array.from({ length: 153 }, (_, i) => message(i));
  const reader = pages(all); let state = options(); const processed: string[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await readTopicIncrement(reader, state);
    processed.push(...result.messages.map(item => item.id));
    state = { ...state, cursor: result.cursor ?? undefined, checkpoint: result.checkpoint };
    if (!result.partial) break;
  }
  expect(processed).toEqual(all.map(item => item.id));
  expect(reader).toHaveBeenCalledTimes(4);
  expect(decodeCursor(state.cursor!).ids).toEqual(['om_152']);
});
it('checkpoints bounded scans before the success cursor without requesting a model window', async () => {
  const all = Array.from({ length: 160 }, (_, i) => message(i));
  const reader = pages(all);
  const before = encodeCursor({ time: all[149].createdAt, ids: [all[149].id] });
  const first = await readTopicIncrement(reader, options({ cursor: before, maxPages: 1 }));
  expect(first.messages).toEqual([]); expect(first.cursor).toBe(before); expect(first.partial).toBe(true);
  const second = await readTopicIncrement(reader, options({ cursor: before, checkpoint: first.checkpoint, maxPages: 1 }));
  expect(second.messages).toEqual([]);
  const third = await readTopicIncrement(reader, options({ cursor: before, checkpoint: second.checkpoint, maxPages: 2 }));
  expect(third.messages.map(item => item.id)).toEqual(all.slice(150).map(item => item.id));
});
it('tracks same-millisecond ids across split pages, duplicate boundaries and late arrivals', async () => {
  const all = Array.from({ length: 54 }, (_, i) => message(i, 0));
  all.splice(50, 0, all[49]);
  const reader = pages(all); let state = options({ maxMessages: 17 }); const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const result = await readTopicIncrement(reader, state); ids.push(...result.messages.map(item => item.id));
    state = { ...state, cursor: result.cursor!, checkpoint: result.checkpoint };
    if (!result.partial) break;
  }
  expect(ids).toHaveLength(54); expect(new Set(ids).size).toBe(54);
  all.push(message(99, 0));
  const late = await readTopicIncrement(reader, { ...state, maxPages: 5 });
  expect(late.messages.map(item => item.id)).toEqual(['om_99']);
  expect(decodeCursor(late.cursor!).ids).toHaveLength(55);
});
it('retains a message that does not fit rather than truncating text and advancing past it', async () => {
  const one = message(1), large = { ...message(2), text: 'x'.repeat(2000) };
  const result = await readTopicIncrement(pages([one, large]), options({ maxChars: 1000 }));
  expect(result.messages).toEqual([one]);
  expect(result.checkpoint!.pending).toEqual([large]);
  expect(decodeCursor(result.cursor!).ids).toEqual([one.id]);
  await expect(readTopicIncrement(pages([]), options({ cursor: result.cursor!, checkpoint: result.checkpoint, maxChars: 1000 }))).rejects.toThrow('topic_source_message_over_budget');
});
it('records observed latest time before a later page failure without returning a successful cursor', async () => {
  const observe = vi.fn();
  const reader = vi.fn().mockResolvedValueOnce({ messages: [message(1)], hasMore: true, nextToken: 'next', verifiedThread: true }).mockRejectedValueOnce(new Error('source failed'));
  await expect(readTopicIncrement(reader, options({ observe }))).rejects.toThrow('source failed');
  expect(observe).toHaveBeenCalledWith(expect.objectContaining({ latestAt: message(1).createdAt }));
});
it.each([
  { messages: [message(2), message(1)], hasMore: false, verifiedThread: true, error: 'topic_source_unordered_page' },
  { messages: [], hasMore: true, verifiedThread: true, error: 'topic_source_pagination_loop' },
  { messages: [message(1)], hasMore: false, verifiedThread: false, error: 'topic_source_unverified_thread' },
])('rejects incomplete or unverified page contracts', async ({ error, ...page }) => {
  await expect(readTopicIncrement(async () => page, options())).rejects.toThrow(error);
});
it('rejects a repeated pagination token, including across saved traversals', async () => {
  const reader = async () => ({ messages: [], hasMore: true, nextToken: 'loop', verifiedThread: true });
  const first = await readTopicIncrement(reader, options({ maxPages: 1 }));
  await expect(readTopicIncrement(reader, options({ checkpoint: first.checkpoint }))).rejects.toThrow('topic_source_pagination_loop');
});
it('ignores an obsolete checkpoint after a concurrent successful cursor change', async () => {
  const reader = pages(Array.from({ length: 70 }, (_, i) => message(i)));
  const first = await readTopicIncrement(reader, options());
  reader.mockClear();
  await readTopicIncrement(reader, options({ checkpoint: first.checkpoint, cursor: encodeCursor({ time: message(50).createdAt, ids: ['om_50'] }) }));
  expect(reader.mock.calls[0][0]).toBeUndefined();
});
it('cancellation prevents another source request', async () => {
  const abort = new AbortController(), reader = pages([message(1)]); abort.abort();
  await expect(readTopicIncrement(reader, options({ signal: abort.signal }))).rejects.toThrow();
  expect(reader).not.toHaveBeenCalled();
});
it('rejects impossible calendar dates instead of silently normalizing them into another month', async () => {
  const { normalizeTime } = await import('../../src/topic/source.js');
  expect(() => normalizeTime('2026-02-30T00:00:00Z')).toThrow('invalid_source_time');
  expect(normalizeTime('2024-02-29T23:00:00+08:00')).toBe('2024-02-29T15:00:00.000Z');
});
