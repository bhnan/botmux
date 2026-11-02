import { expect, it, vi } from 'vitest';
import { readLarkTopicPage } from '../../src/topic/lark-source.js';
const options = { signal: new AbortController().signal, timeoutMs: 1000 };
const location = { chatId: 'oc_a', rootMessageId: 'om_root' };
const root = { message_id: 'om_root', chat_id: 'oc_a', thread_id: 'omt_a', create_time: '1790812800000', msg_type: 'text', body: { content: JSON.stringify({ text: 'hello' }) } };
it('resolves a native thread and normalizes its real root creation time and message content', async () => {
  const deps = { getRoot: vi.fn().mockResolvedValue({ items: [root] }), page: vi.fn().mockResolvedValue({ items: [root], hasMore: true, nextToken: 'next' }) };
  const result = await readLarkTopicPage('app', location, options, deps);
  expect(result).toMatchObject({ verifiedThread: true, hasMore: true, nextToken: 'next', topicCreatedAt: '2026-10-01T00:00:00.000Z', messages: [{ id: 'om_root', text: 'hello' }] });
  expect(deps.page).toHaveBeenCalledWith('app', 'omt_a', options);
});
it('keeps pagination tokens opaque and supports a known thread after its root was removed', async () => {
  const deps = { getRoot: vi.fn(), page: vi.fn().mockResolvedValue({ items: [], hasMore: false }) };
  const result = await readLarkTopicPage('app', { ...location, nativeThreadId: 'omt_a' }, { ...options, token: 'opaque/+' }, deps);
  expect(deps.getRoot).not.toHaveBeenCalled();
  expect(deps.page.mock.calls[0][2].token).toBe('opaque/+');
  expect(result.topicCreatedAt).toBeUndefined();
});
it.each([{ ...root, thread_id: undefined }, { ...root, chat_id: 'oc_other' }])('does not treat an unverified root-only/chat scan as a thread', async value => {
  const deps = { getRoot: vi.fn().mockResolvedValue({ items: [value] }), page: vi.fn() };
  await expect(readLarkTopicPage('app', location, options, deps)).rejects.toThrow('topic_source_unverified_thread');
  expect(deps.page).not.toHaveBeenCalled();
});
it('rejects cross-topic source data rather than letting it become model evidence', async () => {
  const deps = { getRoot: vi.fn(), page: vi.fn().mockResolvedValue({ items: [{ ...root, thread_id: 'omt_other' }], hasMore: false }) };
  await expect(readLarkTopicPage('app', { ...location, nativeThreadId: 'omt_a' }, options, deps)).rejects.toThrow('topic_source_scope_mismatch');
});
