// Browser-safe identity helpers. The Dashboard's existing key encoding is unchanged.
import { isNativeTopicId } from '../core/native-topic-id.js';

export interface TopicLocation {
  chatId?: unknown;
  rootMessageId?: unknown;
  sessionId?: unknown;
  scope?: unknown;
  larkThreadId?: unknown;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function sessionTopicKey(row: TopicLocation): string {
  const chat = text(row.chatId);
  const root = text(row.rootMessageId);
  if (row.scope !== 'chat' && chat && root) return `thread:${encodeURIComponent(chat)}:${encodeURIComponent(root)}`;
  if (row.scope === 'chat' && chat) return `chat:${encodeURIComponent(chat)}`;
  return `session:${encodeURIComponent(text(row.sessionId) || 'unknown')}`;
}

/** A virtual/deferred anchor may be grouped in the UI but must never enter the index. */
export function topicIdentity(row: TopicLocation): {
  topicKey: string; chatId: string; rootMessageId: string; nativeThreadId?: string;
} | null {
  const chatId = text(row.chatId);
  const rootMessageId = text(row.rootMessageId);
  if (row.scope === 'chat' || !chatId || !/^om_[A-Za-z0-9_-]+$/.test(rootMessageId)) return null;
  return {
    topicKey: sessionTopicKey(row), chatId, rootMessageId,
    ...(isNativeTopicId(row.larkThreadId) ? { nativeThreadId: row.larkThreadId } : {}),
  };
}
