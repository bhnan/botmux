import { expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => vi.fn());
vi.mock('../../src/bot-registry.js', () => ({ getBotClient: () => ({}) }));
vi.mock('../../src/im/lark/lark-get.js', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), larkGet: transport }));
import { listNativeThreadPage } from '../../src/im/lark/client.js';
it('requests a single ascending native-container page and propagates cancellation/bounds to shared transport', async () => {
  transport.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'om_a' }], has_more: true, page_token: 'next' } });
  const signal = new AbortController().signal;
  const result = await listNativeThreadPage('app', 'omt_a', { token: 'opaque', signal, timeoutMs: 1234 });
  expect(result).toEqual({ items: [{ message_id: 'om_a' }], hasMore: true, nextToken: 'next' });
  expect(transport).toHaveBeenLastCalledWith({}, '/open-apis/im/v1/messages', expect.objectContaining({ container_id_type: 'thread', container_id: 'omt_a', sort_type: 'ByCreateTimeAsc', page_size: 50, page_token: 'opaque' }), { signal, timeoutMs: 1234 });
});
it.each([{ has_more: false }, { items: [] }, { items: [], has_more: true }])('rejects a malformed completeness contract instead of presenting it as end-of-history', async data => {
  transport.mockResolvedValueOnce({ code: 0, data });
  await expect(listNativeThreadPage('app', 'omt_a')).rejects.toThrow('incomplete_topic_source_page');
});
