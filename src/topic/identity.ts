/** Shared topic identity logic — pure, browser-safe, no runtime dependencies.
 *
 * This module is the single source of truth for the topic location key used by
 * both the Dashboard topic view and the persisted `Topic` catalog. It must
 * stay importable from browser bundles (no node:/daemon imports).
 *
 * Identity rules (spec 20261028-topic-search §3.1):
 * - `chatId + rootMessageId` (a real `om_` routing root) is the topic
 *   identity; `larkThreadId`/`omt_*` is a native jump handle and must never be
 *   substituted for the routing anchor.
 * - Only `kind=thread` locations mint persisted Topics. Chat-scope, DM and
 *   virtual anchors (deferred schedule runs, headless synthetic ids) never do.
 */
import { isNativeTopicId } from '../core/native-topic-id.js';

export type SessionTopicKind = 'thread' | 'chat' | 'session';

export function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function sessionTopicKind(s: any): SessionTopicKind {
  const chatId = nonEmptyString(s?.chatId);
  const rootMessageId = nonEmptyString(s?.rootMessageId);
  if (s?.scope === 'chat') return chatId ? 'chat' : 'session';
  return chatId && rootMessageId ? 'thread' : 'session';
}

/** Stable location key for the current schema. Keep it separate from any
 * future `collaborationId`: location and logical task identity are different
 * dimensions and must not silently alias each other. */
export function sessionTopicKey(s: any): string {
  const chatId = nonEmptyString(s?.chatId);
  const rootMessageId = nonEmptyString(s?.rootMessageId);
  const kind = sessionTopicKind(s);
  if (kind === 'thread') {
    return `thread:${encodeURIComponent(chatId)}:${encodeURIComponent(rootMessageId)}`;
  }
  if (kind === 'chat') return `chat:${encodeURIComponent(chatId)}`;
  return `session:${encodeURIComponent(nonEmptyString(s?.sessionId) || 'unknown')}`;
}

/** Real Lark message ids (open-platform routing anchors) are `om_`-prefixed.
 * Virtual/synthetic anchors (deferred `schedule-task:*`, headless ids) are not
 * replyable thread roots and must not mint Topics. */
export function isRealRoutingAnchor(rootMessageId: unknown): boolean {
  return typeof rootMessageId === 'string' && rootMessageId.startsWith('om_');
}

export function threadTopicKey(chatId: string, rootMessageId: string): string {
  return `thread:${encodeURIComponent(chatId)}:${encodeURIComponent(rootMessageId)}`;
}

/** Inverse of `threadTopicKey`; returns null for chat/session keys or
 * malformed input. */
export function parseThreadTopicKey(key: string): { chatId: string; rootMessageId: string } | null {
  if (typeof key !== 'string' || !key.startsWith('thread:')) return null;
  const rest = key.slice('thread:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  let chatId: string;
  let rootMessageId: string;
  try {
    chatId = decodeURIComponent(rest.slice(0, sep));
    rootMessageId = decodeURIComponent(rest.slice(sep + 1));
  } catch {
    return null;
  }
  if (!chatId || !rootMessageId) return null;
  return { chatId, rootMessageId };
}

export interface TopicIdentity {
  /** Same encoding as `sessionTopicKey` for thread locations. */
  topicKey: string;
  chatId: string;
  /** Real `om_` routing root of the thread. */
  rootMessageId: string;
}

/** Resolve a session-like Dashboard row to a persisted-Topic identity.
 *
 * Returns null when the row must NOT mint a Topic:
 * - not a thread location (chat-scope, missing anchor)
 * - DM chats (p2p) — plan P1: chat/DM/virtual anchors are skipped
 * - headless synthetic sessions
 * - virtual routing anchors (deferred schedule runs not yet bound to a real
 *   root; after materialization the row carries the real `om_` root and is
 *   discovered here).
 *
 * Relay/fork need no special case: identity follows the row's current
 * anchor, so a relayed session resolves to the target topic and a forked
 * thread to its own new key; persisted knowledge under the old key is not
 * moved (that is store semantics, not identity). */
export function topicIdentityFromSessionRow(row: any): TopicIdentity | null {
  if (!row || row.headless) return null;
  if (sessionTopicKind(row) !== 'thread') return null;
  if (row.chatType === 'p2p') return null;
  const chatId = nonEmptyString(row.chatId);
  const rootMessageId = nonEmptyString(row.rootMessageId);
  if (!isRealRoutingAnchor(rootMessageId)) return null;
  return { topicKey: threadTopicKey(chatId, rootMessageId), chatId, rootMessageId };
}

/** Validated native thread handle (`omt_*`) for jump links, if the row has
 * one. Invalid values are dropped rather than trusted: the native id is
 * display metadata, never the identity. */
export function topicNativeThreadId(row: any): string | undefined {
  const value = nonEmptyString(row?.larkThreadId);
  return isNativeTopicId(value) ? value : undefined;
}
