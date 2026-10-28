/** Topic search feature configuration (spec 20261028-topic-search §4).
 *
 * Two layers, mirroring the voice-config precedent:
 * - `global-config.ts` reads the raw `topicSearch` block leniently (structural
 *   whitelist, garbage dropped) so a hand-edited file never breaks unrelated
 *   config reads. The raw types live THERE.
 * - This module owns the strict resolver: it turns the lenient raw block into
 *   an effective `TopicSearchConfig` with validated bounds, or reports why the
 *   feature must stay off. The runtime (P4) starts NOTHING unless resolution
 *   succeeds with enabled=true.
 *
 * Credential rule: the config stores ONLY an env-var NAME (`apiKeyEnv`).
 * The secret itself is resolved from the host process environment at call
 * time and never echoed, logged, or written into the store (spec §4).
 */
import { isValidTimeZone } from '../utils/timezone.js';

export const TOPIC_SEARCH_DEFAULTS = {
  initialLookbackDays: 14,
  maxConcurrentTopics: 1,
  maxTopicsPerRun: 20,
  modelTimeoutMs: 120_000,
  modelMaxRetries: 2,
  modelMaxInputChars: 200_000,
} as const;

export const TOPIC_SEARCH_BOUNDS = {
  initialLookbackDays: { min: 1, max: 365 },
  maxConcurrentTopics: { min: 1, max: 8 },
  maxTopicsPerRun: { min: 1, max: 200 },
} as const;

/** Provider protocols a first-version model connection may declare. A profile
 * without a known protocol is invalid — never assume an arbitrary chat model
 * supports embedding or structured output (spec §4). */
export type TopicModelProvider = 'openai-compatible';

export interface TopicModelProfile {
  provider: TopicModelProvider;
  /** http(s) base URL of the OpenAI-compatible API origin. */
  baseUrl: string;
  model: string;
  /** Env var NAME holding the API key. Never the key itself. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Input budget for one call (chars). */
  maxInputChars?: number;
  /** Embedding-only: declared vector dimensions. Required for embedding. */
  dimensions?: number;
  /** Embedding-only: model revision, folded into the vector space key. */
  modelRevision?: string;
}

export interface TopicSearchScheduleRaw {
  kind?: unknown;
  expression?: unknown;
  time?: unknown;
  intervalMinutes?: unknown;
  timeZone?: unknown;
}

export interface TopicSearchSchedule {
  kind: 'cron' | 'fixed-time' | 'interval';
  expression?: string;
  time?: string;
  intervalMinutes?: number;
  /** IANA zone; required for cron/fixed-time (spec §4). */
  timeZone?: string;
}

export interface TopicSearchConfig {
  enabled: true;
  allowedChatIds: string[];
  llm: TopicModelProfile;
  embedding: { enabled: false } | { enabled: true; model: TopicModelProfile };
  schedule: TopicSearchSchedule;
  initialLookbackDays: number;
  maxConcurrentTopics: number;
  maxTopicsPerRun: number;
}

export type TopicSearchConfigResolution =
  | { enabled: false; reasons: string[] }
  | { enabled: true; config: TopicSearchConfig };

export interface TopicSearchRawConfig {
  enabled?: unknown;
  allowedChatIds?: unknown;
  llm?: unknown;
  embedding?: unknown;
  schedule?: unknown;
  initialLookbackDays?: unknown;
  maxConcurrentTopics?: unknown;
  maxTopicsPerRun?: unknown;
}

/** Stable identity of a model profile: folded into embedding modelKey so
 * vectors from different spaces never mix (spec §6.1 modelKey/维度一致). */
export function topicModelKey(profile: TopicModelProfile): string {
  const dims = profile.dimensions !== undefined ? `:${profile.dimensions}` : '';
  const rev = profile.modelRevision ? `@${profile.modelRevision}` : '';
  return `${profile.provider}/${profile.model}${rev}${dims}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readModelProfile(raw: unknown, context: 'llm' | 'embedding'): { ok: true; profile: TopicModelProfile } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `topic_search_${context}_missing` };
  const v = raw as Record<string, unknown>;
  if (v.provider !== 'openai-compatible') return { ok: false, error: `topic_search_${context}_provider_unsupported` };
  const baseUrl = nonEmptyString(v.baseUrl);
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return { ok: false, error: `topic_search_${context}_base_url_invalid` };
  const model = nonEmptyString(v.model);
  if (!model) return { ok: false, error: `topic_search_${context}_model_missing` };
  const apiKeyEnv = nonEmptyString(v.apiKeyEnv);
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    return { ok: false, error: `topic_search_${context}_api_key_env_invalid` };
  }
  // A literal key in the config file is a hard error, not a warning: spec §4
  // credentials must live in host-protected storage only.
  if (typeof v.apiKey === 'string' && v.apiKey) return { ok: false, error: `topic_search_${context}_api_key_inline_forbidden` };
  const profile: TopicModelProfile = {
    provider: 'openai-compatible',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
  if (v.timeoutMs !== undefined) {
    if (typeof v.timeoutMs !== 'number' || !Number.isSafeInteger(v.timeoutMs) || v.timeoutMs < 1_000 || v.timeoutMs > 600_000) {
      return { ok: false, error: `topic_search_${context}_timeout_invalid` };
    }
    profile.timeoutMs = v.timeoutMs;
  }
  if (v.maxRetries !== undefined) {
    if (typeof v.maxRetries !== 'number' || !Number.isSafeInteger(v.maxRetries) || v.maxRetries < 0 || v.maxRetries > 5) {
      return { ok: false, error: `topic_search_${context}_retries_invalid` };
    }
    profile.maxRetries = v.maxRetries;
  }
  if (v.maxInputChars !== undefined) {
    if (typeof v.maxInputChars !== 'number' || !Number.isSafeInteger(v.maxInputChars) || v.maxInputChars < 1_000) {
      return { ok: false, error: `topic_search_${context}_input_budget_invalid` };
    }
    profile.maxInputChars = v.maxInputChars;
  }
  if (context === 'embedding') {
    if (typeof v.dimensions !== 'number' || !Number.isSafeInteger(v.dimensions) || v.dimensions < 2 || v.dimensions > 8_192) {
      return { ok: false, error: 'topic_search_embedding_dimensions_invalid' };
    }
    profile.dimensions = v.dimensions;
    const modelRevision = nonEmptyString(v.modelRevision);
    if (modelRevision) profile.modelRevision = modelRevision;
  }
  return { ok: true, profile };
}

function readSchedule(raw: unknown): { ok: true; schedule: TopicSearchSchedule } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'topic_search_schedule_missing' };
  }
  const v = raw as TopicSearchScheduleRaw;
  const timeZone = nonEmptyString(v.timeZone);
  if (v.kind === 'cron') {
    const expression = nonEmptyString(v.expression);
    if (!expression) return { ok: false, error: 'topic_search_schedule_cron_expression_missing' };
    if (!timeZone || !isValidTimeZone(timeZone)) return { ok: false, error: 'topic_search_schedule_time_zone_invalid' };
    return { ok: true, schedule: { kind: 'cron', expression, timeZone } };
  }
  if (v.kind === 'fixed-time') {
    const time = nonEmptyString(v.time);
    if (!time || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: 'topic_search_schedule_time_invalid' };
    if (!timeZone || !isValidTimeZone(timeZone)) return { ok: false, error: 'topic_search_schedule_time_zone_invalid' };
    return { ok: true, schedule: { kind: 'fixed-time', time, timeZone } };
  }
  if (v.kind === 'interval') {
    // interval and cron/fixed-time are mutually exclusive by construction
    // (one `kind`); anything else present is ignored, not merged.
    if (typeof v.intervalMinutes !== 'number' || !Number.isSafeInteger(v.intervalMinutes) || v.intervalMinutes < 15) {
      return { ok: false, error: 'topic_search_schedule_interval_invalid' };
    }
    return { ok: true, schedule: { kind: 'interval', intervalMinutes: v.intervalMinutes } };
  }
  return { ok: false, error: 'topic_search_schedule_kind_invalid' };
}

function readBoundedNumber(raw: unknown, bound: { min: number; max: number }, fallback: number, error: string): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < bound.min || raw > bound.max) {
    return { ok: false, error };
  }
  return { ok: true, value: raw };
}

/** Strict resolver. Absent/garbage config ⇒ disabled with reasons (feature is
 * default-off; a bad config must degrade to OFF, never to defaults-that-run). */
export function resolveTopicSearchConfig(raw: TopicSearchRawConfig | undefined): TopicSearchConfigResolution {
  const reasons: string[] = [];
  if (!raw || typeof raw !== 'object') return { enabled: false, reasons: ['topic_search_not_configured'] };
  if (raw.enabled !== true) return { enabled: false, reasons: ['topic_search_disabled'] };
  let allowedChatIds: string[] = [];
  if (!Array.isArray(raw.allowedChatIds) || raw.allowedChatIds.length === 0) {
    // No authorized chat scope ⇒ refuse to enable (spec §9: 启用配置必须明确群范围).
    reasons.push('topic_search_allowed_chat_ids_missing');
  } else {
    const ids = [...new Set(raw.allowedChatIds
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim()))];
    if (ids.length === 0) reasons.push('topic_search_allowed_chat_ids_missing');
    else allowedChatIds = ids;
  }
  const llm = readModelProfile(raw.llm, 'llm');
  if (!llm.ok) reasons.push(llm.error);
  const schedule = readSchedule(raw.schedule);
  if (!schedule.ok) reasons.push(schedule.error);
  const embeddingRaw = raw.embedding;
  let embedding: TopicSearchConfig['embedding'] = { enabled: false };
  if (embeddingRaw && typeof embeddingRaw === 'object' && (embeddingRaw as { enabled?: unknown }).enabled === true) {
    const model = readModelProfile((embeddingRaw as { model?: unknown }).model, 'embedding');
    if (!model.ok) reasons.push(model.error);
    else embedding = { enabled: true, model: model.profile };
  }
  const initialLookbackDays = readBoundedNumber(raw.initialLookbackDays, TOPIC_SEARCH_BOUNDS.initialLookbackDays, TOPIC_SEARCH_DEFAULTS.initialLookbackDays, 'topic_search_lookback_invalid');
  if (!initialLookbackDays.ok) reasons.push(initialLookbackDays.error);
  const maxConcurrentTopics = readBoundedNumber(raw.maxConcurrentTopics, TOPIC_SEARCH_BOUNDS.maxConcurrentTopics, TOPIC_SEARCH_DEFAULTS.maxConcurrentTopics, 'topic_search_concurrency_invalid');
  if (!maxConcurrentTopics.ok) reasons.push(maxConcurrentTopics.error);
  const maxTopicsPerRun = readBoundedNumber(raw.maxTopicsPerRun, TOPIC_SEARCH_BOUNDS.maxTopicsPerRun, TOPIC_SEARCH_DEFAULTS.maxTopicsPerRun, 'topic_search_topics_per_run_invalid');
  if (!maxTopicsPerRun.ok) reasons.push(maxTopicsPerRun.error);
  if (reasons.length > 0 || !llm.ok || !schedule.ok
    || !initialLookbackDays.ok || !maxConcurrentTopics.ok || !maxTopicsPerRun.ok) return { enabled: false, reasons };
  return {
    enabled: true,
    config: {
      enabled: true,
      allowedChatIds,
      llm: llm.profile,
      embedding,
      schedule: schedule.schedule,
      initialLookbackDays: initialLookbackDays.value,
      maxConcurrentTopics: maxConcurrentTopics.value,
      maxTopicsPerRun: maxTopicsPerRun.value,
    },
  };
}

/** Resolve the API key for a profile from the host environment. Returns
 * undefined when the env var is unset — the caller treats an unauthorized
 * provider as a model failure, never as a prompt for the key material. */
export function resolveTopicModelApiKey(profile: TopicModelProfile, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!profile.apiKeyEnv) return undefined;
  const value = env[profile.apiKeyEnv];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
