import { expect, it, vi } from 'vitest';
import { topicSearchApi, topicSourceViewApi } from '../../src/dashboard/topic-search-api.js';
import { topicSourcePageApi, topicSourceCheckApi } from '../../src/topic/source-api.js';
import { TopicSearchError } from '../../src/topic/search.js';
import { resolveDashboardRequestGate } from '../../src/dashboard/request-identity.js';

it('the real Dashboard auth gate does not publish topic search to anonymous public-read visitors', () => {
  const gate = resolveDashboardRequestGate({ method: 'POST', pathname: '/api/topic-search', hasTokenParam: false, identity: null, tokenFromRequest: undefined, activeToken: 'private', publicReadOnly: true });
  expect(gate.decision.kind).toBe('deny401');
});
it('requires sensitive-history management authority, not merely an authenticated Workbench identity', async () => {
  const service = { search: vi.fn().mockResolvedValue({ items: [] }) };
  expect((await topicSearchApi({}, { canManageHost: false }, service)).status).toBe(401);
  expect((await topicSearchApi({}, { canManageHost: false, principal: 'workbench' }, service)).status).toBe(403);
  expect(service.search).not.toHaveBeenCalled();
  expect((await topicSearchApi({ query: 'x' }, { canManageHost: true, principal: 'owner' }, service)).status).toBe(200);
  expect(service.search).toHaveBeenCalledWith({ query: 'x' }, { principal: 'owner', chatIds: null });
});
it('returns documented safe API errors and never raw source/model secrets', async () => {
  const service = { search: vi.fn().mockRejectedValue(new Error('private credentials')) };
  expect(await topicSearchApi({}, { canManageHost: true, principal: 'owner' }, service)).toEqual({ status: 503, body: { error: 'topic_search_unavailable' } });
  service.search.mockRejectedValueOnce(new TopicSearchError(429, 'topic_search_busy'));
  expect((await topicSearchApi({}, { canManageHost: true, principal: 'owner' }, service)).status).toBe(429);
});
it('source pages require both trusted-host proof and update allowlist, even with a real-looking location', async () => {
  const read = vi.fn().mockResolvedValue({ messages: [], hasMore: false, verifiedThread: true });
  const deps = { trustedHost: false, allowedChatIds: ['oc_a'], signal: new AbortController().signal, read };
  const body = { chatId: 'oc_a', rootMessageId: 'om_root', nativeThreadId: 'omt_a' };
  expect((await topicSourcePageApi(body, deps)).status).toBe(403);
  expect((await topicSourcePageApi(body, { ...deps, trustedHost: true, allowedChatIds: [] })).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  expect((await topicSourcePageApi(body, { ...deps, trustedHost: true })).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(1);
});
it('rejects fake source anchors, invalid tokens and wrong native id namespace before transport', async () => {
  const read = vi.fn(), deps = { trustedHost: true, allowedChatIds: ['oc_a'], signal: new AbortController().signal, read };
  for (const body of [{ chatId: 'oc_a', rootMessageId: 'virtual:root' }, { chatId: 'oc_a', rootMessageId: 'om_a', nativeThreadId: 'om_a' }, { chatId: 'oc_a', rootMessageId: 'om_a', token: 'x'.repeat(4097) }]) expect((await topicSourcePageApi(body, deps)).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it('source review uses the same trusted-host/update-scope boundary and validates referenced message IDs', async () => {
  const check = vi.fn().mockResolvedValue({ state: 'unknown' });
  const deps = { trustedHost: true, allowedChatIds: ['oc_a'], signal: new AbortController().signal, check };
  const body = { chatId: 'oc_a', rootMessageId: 'om_root', nativeThreadId: 'omt_a', messageId: 'om_ref' };
  expect((await topicSourceCheckApi(body, { ...deps, trustedHost: false })).status).toBe(403);
  expect((await topicSourceCheckApi(body, { ...deps, allowedChatIds: [] })).status).toBe(403);
  expect((await topicSourceCheckApi({ ...body, messageId: 'virtual:ref' }, deps)).status).toBe(400);
  expect(check).not.toHaveBeenCalled();
  expect(await topicSourceCheckApi(body, deps)).toEqual({ status: 200, body: { state: 'unknown' } });
});

it('source navigation preserves sensitive-history authentication and returns raw text only after authorization', async () => {
  const read = vi.fn().mockResolvedValue({ title: 'T', message: { id: 'om_a', createdAt: '2026-10-01T00:00:00.000Z', text: '<script>untrusted</script>' } });
  const input = { topicKey: 'thread:oc_a:om_root', messageId: 'om_a' }, signal = new AbortController().signal;
  expect((await topicSourceViewApi(input, { canManageHost: false }, read, signal)).status).toBe(401);
  expect((await topicSourceViewApi(input, { canManageHost: false, principal: 'visitor' }, read, signal)).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const result = await topicSourceViewApi(input, { canManageHost: true, principal: 'owner' }, read, signal);
  expect(result.status).toBe(200); expect(result.body).toContain('om_a');
  read.mockRejectedValue(new Error('private raw provider error'));
  expect(await topicSourceViewApi(input, { canManageHost: true, principal: 'owner' }, read, signal)).toEqual({ status: 503, body: 'topic_source_unavailable' });
});
