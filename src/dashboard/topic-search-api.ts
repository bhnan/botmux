import { TopicSearchError, type TopicSearchService } from '../topic/search.js';

export async function topicSearchApi(body: unknown, identity: { canManageHost: boolean; principal?: string }, service: Pick<TopicSearchService, 'search'> | null): Promise<{ status: number; body: unknown }> {
  // Same host-management authority as sensitive session history. Not a Workbench/public-read grant.
  if (!identity.principal) return { status: 401, body: { error: 'topic_search_authentication_required' } };
  if (!identity.canManageHost) return { status: 403, body: { error: 'topic_search_scope_denied' } };
  if (!service) return { status: 503, body: { error: 'topic_search_unavailable' } };
  try { return { status: 200, body: await service.search(body, { principal: identity.principal, chatIds: null }) }; }
  catch (error) {
    return error instanceof TopicSearchError ? { status: error.status, body: { error: error.message } } : { status: 503, body: { error: 'topic_search_unavailable' } };
  }
}

/** Plain-text navigation avoids inventing an unverified Lark message deep-link protocol. */
export async function topicSourceViewApi(input: { topicKey: string; messageId: string }, identity: { canManageHost: boolean; principal?: string }, read: (key: string, id: string, signal: AbortSignal) => Promise<{ title: string; message: import('../topic/source.js').TopicMessage }>, signal: AbortSignal): Promise<{ status: number; body: string }> {
  if (!identity.principal) return { status: 401, body: 'topic_search_authentication_required' };
  if (!identity.canManageHost) return { status: 403, body: 'topic_search_scope_denied' };
  try {
    const result = await read(input.topicKey, input.messageId, signal);
    return { status: 200, body: `${result.title}\n${result.message.id}\n${result.message.createdAt}\n\n${result.message.text}` };
  } catch (error) {
    return error instanceof TopicSearchError ? { status: error.status, body: error.message } : { status: 503, body: 'topic_source_unavailable' };
  }
}
