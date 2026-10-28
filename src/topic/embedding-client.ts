/** Optional embedding model client (spec 20261028-topic-search §4/§5.1).
 *
 * Embedding is opt-in; when disabled nothing here is ever called and no key
 * is required (the runtime must not even initialize this client). The
 * profile's declared dimensions are checked against the provider response —
 * a mismatched space is a hard error, never a silently-mixed vector space.
 */
import { isLoopbackUrl, loopbackFetch } from '../core/loopback-fetch.js';
import { resolveTopicModelApiKey, topicModelKey, type TopicModelProfile } from './config.js';

export type TopicEmbeddingError =
  | 'http_error'
  | 'timeout'
  | 'unauthorized'
  | 'invalid_output'
  | 'dimension_mismatch'
  | 'not_a_number_vector';

export type TopicEmbeddingResult =
  | { ok: true; vector: number[]; modelKey: string }
  | { ok: false; code: TopicEmbeddingError };

export interface TopicEmbeddingClientOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Embed one summary text. Retries transient failures (429/5xx/network) with
 * linear backoff up to profile.maxRetries; a wrong-dimension response is
 * never retried (it would fail identically). */
export async function embedSummaryText(
  profile: TopicModelProfile,
  text: string,
  options: TopicEmbeddingClientOptions = {},
): Promise<TopicEmbeddingResult> {
  const apiKey = resolveTopicModelApiKey(profile, options.env);
  const url = `${profile.baseUrl}/embeddings`;
  const send = options.fetchImpl ?? (isLoopbackUrl(url) ? loopbackFetch : fetch);
  const timeoutMs = profile.timeoutMs ?? 120_000;
  const maxRetries = profile.maxRetries ?? 2;
  const modelKey = topicModelKey(profile);

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model: profile.model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = (error instanceof Error && error.name === 'TimeoutError') || (error as { code?: string })?.code === 'ABORT_ERR';
      if (timeout) return { ok: false, code: 'timeout' };
      if (attempt < maxRetries) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, code: 'http_error' };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, code: 'unauthorized' };
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxRetries) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, code: 'http_error' };
    }
    if (!response.ok) return { ok: false, code: 'http_error' };

    let embedding: unknown;
    try {
      const json = await response.json() as { data?: Array<{ embedding?: unknown }> };
      embedding = json?.data?.[0]?.embedding;
    } catch {
      if (attempt < maxRetries) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, code: 'invalid_output' };
    }
    if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      return { ok: false, code: 'not_a_number_vector' };
    }
    if (profile.dimensions !== undefined && embedding.length !== profile.dimensions) {
      // Declared protocol capability violated: mixing spaces would silently
      // corrupt similarity — refuse (spec §4 模型连接必须声明支持的能力).
      return { ok: false, code: 'dimension_mismatch' };
    }
    return { ok: true, vector: embedding as number[], modelKey };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
