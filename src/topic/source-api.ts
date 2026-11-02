import { isNativeTopicId } from '../core/native-topic-id.js';
import type { LarkTopicLocation } from './lark-source.js';
import type { TopicSourcePage } from './source.js';

export async function topicSourcePageApi(body: unknown, deps: {
  trustedHost: boolean;
  allowedChatIds: readonly string[];
  signal: AbortSignal;
  read: (location: LarkTopicLocation, options: { token?: string; signal: AbortSignal; timeoutMs: number }) => Promise<TopicSourcePage>;
}): Promise<{ status: number; body: unknown }> {
  if (!deps.trustedHost) return { status: 403, body: { error: 'topic_source_host_authority_required' } };
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof raw.chatId !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(raw.chatId) || typeof raw.rootMessageId !== 'string' || !/^om_[A-Za-z0-9_-]+$/.test(raw.rootMessageId) || (raw.nativeThreadId !== undefined && !isNativeTopicId(raw.nativeThreadId)) || (raw.token !== undefined && (typeof raw.token !== 'string' || raw.token.length > 4096))) return { status: 400, body: { error: 'invalid_topic_source_request' } };
  if (!deps.allowedChatIds.includes(raw.chatId)) return { status: 403, body: { error: 'topic_source_scope_denied' } };
  try {
    const page = await deps.read({ chatId: raw.chatId, rootMessageId: raw.rootMessageId, ...(raw.nativeThreadId ? { nativeThreadId: raw.nativeThreadId as string } : {}) }, { token: raw.token as string | undefined, signal: deps.signal, timeoutMs: 10_000 });
    return { status: 200, body: page };
  } catch { return { status: 502, body: { error: 'topic_source_unavailable' } }; }
}
