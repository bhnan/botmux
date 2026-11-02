import { getMessageDetail, listNativeThreadPage } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';
import { isNativeTopicId } from '../core/native-topic-id.js';
import type { TopicSourcePage } from './source.js';

export interface LarkTopicLocation { chatId: string; rootMessageId: string; nativeThreadId?: string }
export interface LarkTopicSourceDeps {
  getRoot: typeof getMessageDetail;
  page: typeof listNativeThreadPage;
}
const production: LarkTopicSourceDeps = { getRoot: getMessageDetail, page: listNativeThreadPage };

function sourceTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return undefined;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** No chat-tail fallback: quoted replies cannot establish native-thread membership. */
export async function readLarkTopicPage(
  appId: string, location: LarkTopicLocation,
  options: { token?: string; signal: AbortSignal; timeoutMs: number }, deps: LarkTopicSourceDeps = production,
): Promise<TopicSourcePage> {
  options.signal.throwIfAborted();
  let native = location.nativeThreadId;
  let createdAt: string | undefined;
  if (!native) {
    const data = await deps.getRoot(appId, location.rootMessageId, { signal: options.signal, timeoutMs: options.timeoutMs, userCardContent: false });
    const root = data?.items?.[0];
    if (root?.chat_id !== location.chatId || root?.message_id !== location.rootMessageId || !isNativeTopicId(root?.thread_id)) throw new Error('topic_source_unverified_thread');
    native = root.thread_id;
    createdAt = sourceTime(root.create_time);
  }
  if (!isNativeTopicId(native)) throw new Error('invalid_native_topic_id');
  options.signal.throwIfAborted();
  const page = await deps.page(appId, native, options);
  const messages = page.items.map(raw => {
    if ((raw.chat_id && raw.chat_id !== location.chatId) || (raw.thread_id && raw.thread_id !== native)) throw new Error('topic_source_scope_mismatch');
    const parsed = parseApiMessage(raw, undefined, { resolveMentions: true });
    const at = sourceTime(parsed.createTime);
    if (!at || !/^om_[A-Za-z0-9_-]+$/.test(parsed.messageId)) throw new Error('invalid_topic_source_message');
    if (parsed.messageId === location.rootMessageId) createdAt = at;
    return { id: parsed.messageId, text: raw.deleted === true ? '' : parsed.content, createdAt: at, deleted: raw.deleted === true };
  });
  return { messages, hasMore: page.hasMore, nextToken: page.nextToken, verifiedThread: true, topicCreatedAt: createdAt };
}
