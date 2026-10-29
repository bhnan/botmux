/**
 * 从宿主环境解析摘要 / 向量模型连接。
 *
 * 为什么不是写在 `config.json` 里：配置节只保存**引用**（`llmModelRef` /
 * `embedding.modelRef`），凭证走宿主环境/受限存储，配置命令的 `show` 才不会回显密钥。
 * 这也让「同一份配置换一套凭证」不需要改配置文件。
 *
 * 缺任何一项必要值就返回 null（而不是造一个指向 localhost 的默认 endpoint）：
 * 后台任务静默打到错误地址比直接报 `no_llm_model_ref` 更难排查。
 */

import type { ResolvedTopicSearchConfig } from './config.js';
import type { TopicEmbeddingEndpoint } from './embedding-client.js';
import type { TopicModelEndpoint } from './model-client.js';

export interface TopicEnvEndpoints {
  summary: TopicModelEndpoint | null;
  embedding: TopicEmbeddingEndpoint | null;
}

export interface ResolveTopicEndpointsOptions {
  env?: NodeJS.ProcessEnv;
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(trimmed(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** 解析端点；凭证只在返回值里，不写日志、不进错误消息。 */
export function resolveTopicEndpointsFromEnv(
  config: ResolvedTopicSearchConfig,
  options: ResolveTopicEndpointsOptions = {},
): TopicEnvEndpoints {
  const env = options.env ?? process.env;

  let summary: TopicModelEndpoint | null = null;
  const summaryBaseUrl = trimmed(env.BOTMUX_TOPIC_LLM_BASE_URL);
  const summaryModel = trimmed(env.BOTMUX_TOPIC_LLM_MODEL);
  if (config.llmModelRef && summaryBaseUrl && summaryModel) {
    const apiKey = trimmed(env.BOTMUX_TOPIC_LLM_API_KEY);
    summary = {
      baseUrl: summaryBaseUrl,
      model: summaryModel,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: positiveInt(env.BOTMUX_TOPIC_LLM_TIMEOUT_MS, 60_000),
      maxRetries: positiveInt(env.BOTMUX_TOPIC_LLM_MAX_RETRIES, 2),
      maxOutputChars: positiveInt(env.BOTMUX_TOPIC_LLM_MAX_OUTPUT_CHARS, 16_000),
    };
  }

  let embedding: TopicEmbeddingEndpoint | null = null;
  const embeddingBaseUrl = trimmed(env.BOTMUX_TOPIC_EMBEDDING_BASE_URL);
  const embeddingModel = trimmed(env.BOTMUX_TOPIC_EMBEDDING_MODEL);
  if (config.embedding.enabled && config.embedding.modelRef && embeddingBaseUrl && embeddingModel) {
    const apiKey = trimmed(env.BOTMUX_TOPIC_EMBEDDING_API_KEY);
    const dimensionsRaw = Number(trimmed(env.BOTMUX_TOPIC_EMBEDDING_DIMENSIONS));
    embedding = {
      baseUrl: embeddingBaseUrl,
      model: embeddingModel,
      ...(apiKey ? { apiKey } : {}),
      ...(Number.isFinite(dimensionsRaw) && dimensionsRaw > 0
        ? { dimensions: Math.floor(dimensionsRaw) }
        : {}),
      timeoutMs: positiveInt(env.BOTMUX_TOPIC_EMBEDDING_TIMEOUT_MS, 30_000),
      maxRetries: positiveInt(env.BOTMUX_TOPIC_EMBEDDING_MAX_RETRIES, 2),
    };
  }

  return { summary, embedding };
}
