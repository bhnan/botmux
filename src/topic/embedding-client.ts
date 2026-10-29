/**
 * 可选 embedding 客户端（OpenAI-compatible `/embeddings`）。
 *
 * 关闭时**不创建客户端**：没有 endpoint 就没有 HTTP 调用、不要求密钥、不初始化任何
 * 东西——这是 spec 里「embedding 关闭无密钥可启动」的落点。
 *
 * `modelKey` 把 provider/模型/维度绑成一个不可混用的空间标识：换模型或换维度后，
 * 旧向量不再参与相似度计算（见 vector.ts 的维度校验），回填完成前该话题退回关键词召回。
 */

import { isLoopbackUrl, loopbackFetch } from '../core/loopback-fetch.js';
import { TopicModelError, type TopicClientDeps } from './model-client.js';
import { validateEmbeddingVector } from './vector.js';

export interface TopicEmbeddingEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs: number;
  maxRetries: number;
  /** 已知维度时严格校验响应；未知则按首次响应落定。 */
  dimensions?: number;
}

export interface TopicEmbedder {
  modelKey: string;
  embed(text: string): Promise<number[]>;
}

function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid';
  }
}

/** 模型空间标识：`host/model/revision(dimensions)`，不含凭证。 */
export function topicEmbeddingModelKey(endpoint: TopicEmbeddingEndpoint): string {
  const dims = endpoint.dimensions === undefined ? 'auto' : String(endpoint.dimensions);
  return `${hostOf(endpoint.baseUrl)}/${endpoint.model}/${dims}`;
}

export function createTopicEmbedder(
  endpoint: TopicEmbeddingEndpoint,
  deps: TopicClientDeps = {},
): TopicEmbedder {
  const modelKey = topicEmbeddingModelKey(endpoint);
  const upstream = deps.fetchImpl;
  const send = (url: string, init: RequestInit): Promise<Response> =>
    upstream ? upstream(url, init) : isLoopbackUrl(url) ? loopbackFetch(url, init) : fetch(url, init);
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>(resolve => {
      setTimeout(resolve, ms);
    }));

  async function callOnce(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, Math.max(500, endpoint.timeoutMs));
    let response: Response;
    try {
      response = await send(embeddingsUrl(endpoint.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          ...endpoint.extraHeaders,
        },
        body: JSON.stringify({
          model: endpoint.model,
          input: text,
          ...(endpoint.dimensions === undefined ? {} : { dimensions: endpoint.dimensions }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new TopicModelError('timeout', 'embedding model timed out', { retryable: true });
      }
      throw new TopicModelError('network', 'embedding request failed', { retryable: true });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new TopicModelError('rate_limited', 'embedding model rate limited', {
          retryable: true,
          status: 429,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new TopicModelError('auth', 'embedding model rejected credentials', {
          retryable: false,
          status: response.status,
        });
      }
      throw new TopicModelError('http_error', `embedding model returned ${response.status}`, {
        retryable: response.status >= 500,
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TopicModelError('invalid_json', 'embedding model returned non-JSON body', { retryable: true });
    }
    const vector = (body as { data?: Array<{ embedding?: unknown }> })?.data?.[0]?.embedding;
    const validation = validateEmbeddingVector(vector, endpoint.dimensions);
    if (!validation.ok) {
      // 维度不符/非有限值 = 不可用向量；不能存进去假装有语义召回能力。
      throw new TopicModelError('invalid_output', `embedding vector invalid: ${validation.issue}`);
    }
    return vector as number[];
  }

  return {
    modelKey,
    async embed(text) {
      const attempts = Math.max(1, Math.min(endpoint.maxRetries + 1, 3));
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await callOnce(text);
        } catch (error) {
          lastError = error;
          if (!(error instanceof TopicModelError) || !error.retryable || attempt === attempts - 1) break;
          await sleep(Math.min(500 * 2 ** attempt, 4_000));
        }
      }
      throw lastError instanceof TopicModelError
        ? lastError
        : new TopicModelError('network', 'embedding request failed');
    },
  };
}
