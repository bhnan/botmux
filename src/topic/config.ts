import { Cron } from 'croner';
import { createHash } from 'node:crypto';

export interface TopicModelProfile {
  adapter: 'openai-chat' | 'openai-embeddings';
  endpoint: string;
  model: string;
  credentialRef: string;
  timeoutMs: number;
  retries: number;
  requestsPerMinute: number;
  maxInputChars: number;
  maxOutputTokens: number;
  version: string;
  dimensions?: number;
}
export type TopicSchedule = { kind: 'interval'; everyMs: number } | { kind: 'cron'; expression: string; timeZone: string };
export interface TopicSearchConfig {
  enabled: boolean;
  allowedChatIds: string[];
  llmModelRef: string | null;
  models: Record<string, TopicModelProfile>;
  embedding: { enabled: boolean; modelRef: string | null };
  schedule: TopicSchedule;
  initialLookbackDays: number;
  maxConcurrentTopics: number;
  maxTopicsPerRun: number;
  maxPagesPerRead: number;
  maxMessagesPerBatch: number;
  maxInputChars: number;
  maxOldSummaries: number;
  maxAttempts: number;
  retryBaseMs: number;
  jobTimeoutMs: number;
  overlapHours: number;
  historicalRecheckDays: number;
  maxHistoricalChecksPerRun: number;
  retentionDays: number | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_topic_config');
  return value as Record<string, unknown>;
}
function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('invalid_topic_config');
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid_topic_budget');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)) throw new Error('invalid_topic_model_reference');
  return value;
}

function modelProfile(raw: unknown): TopicModelProfile {
  const r = object(raw);
  if (r.adapter !== 'openai-chat' && r.adapter !== 'openai-embeddings') throw new Error('unsupported_topic_model_adapter');
  let endpoint: URL;
  try { endpoint = new URL(String(r.endpoint)); } catch { throw new Error('invalid_topic_model_endpoint'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid_topic_model_endpoint');
  // Only explicit, dedicated host credentials. Never inherit bot chat env or accept raw API keys.
  if (typeof r.credentialRef !== 'string' || !/^env:BOTMUX_TOPIC_[A-Z0-9_]+$/.test(r.credentialRef)) throw new Error('invalid_topic_credential_reference');
  if (r.apiKey !== undefined || r.token !== undefined || r.headers !== undefined) throw new Error('inline_topic_credentials_forbidden');
  const out: TopicModelProfile = {
    adapter: r.adapter, endpoint: endpoint.toString().replace(/\/$/, ''), model: name(r.model), credentialRef: r.credentialRef,
    timeoutMs: integer(r.timeoutMs, 30_000, 100, 120_000), retries: integer(r.retries, 1, 0, 3),
    requestsPerMinute: integer(r.requestsPerMinute, 30, 1, 600), maxInputChars: integer(r.maxInputChars, 24_000, 256, 128_000),
    maxOutputTokens: integer(r.maxOutputTokens, 2048, 64, 8192), version: name(r.version ?? '1'),
  };
  if (r.adapter === 'openai-embeddings') {
    if (r.dimensions === undefined) throw new Error('missing_topic_embedding_dimensions');
    out.dimensions = integer(r.dimensions, 0, 1, 8192);
  }
  return out;
}

export function parseTopicSearchConfig(raw?: unknown): TopicSearchConfig {
  const r = raw === undefined ? {} : object(raw);
  const embedding = r.embedding === undefined ? {} : object(r.embedding);
  const models: Record<string, TopicModelProfile> = Object.create(null);
  const profiles = r.models === undefined ? {} : object(r.models);
  if (Object.keys(profiles).length > 32) throw new Error('too_many_topic_models');
  for (const [key, value] of Object.entries(profiles)) models[name(key)] = modelProfile(value);
  const allowed = r.allowedChatIds ?? [];
  if (!Array.isArray(allowed) || allowed.length > 1000 || !allowed.every(id => typeof id === 'string' && /^oc_[A-Za-z0-9_-]+$/.test(id))) throw new Error('invalid_topic_update_scope');
  const scheduleRaw = r.schedule === undefined ? { kind: 'interval', everyMs: 86_400_000 } : object(r.schedule);
  let schedule: TopicSchedule;
  if (scheduleRaw.kind === 'interval') {
    if (scheduleRaw.expression !== undefined || scheduleRaw.timeZone !== undefined) throw new Error('conflicting_topic_schedule');
    schedule = { kind: 'interval', everyMs: integer(scheduleRaw.everyMs, 86_400_000, 60_000, 31 * 86_400_000) };
  } else if (scheduleRaw.kind === 'cron') {
    if (scheduleRaw.everyMs !== undefined || typeof scheduleRaw.expression !== 'string' || scheduleRaw.expression.trim().split(/\s+/).length !== 5 || typeof scheduleRaw.timeZone !== 'string') throw new Error('invalid_topic_schedule');
    try {
      new Intl.DateTimeFormat('en', { timeZone: scheduleRaw.timeZone }).format();
      new Cron(scheduleRaw.expression, { timezone: scheduleRaw.timeZone, paused: true });
    } catch { throw new Error('invalid_topic_schedule'); }
    schedule = { kind: 'cron', expression: scheduleRaw.expression.trim(), timeZone: scheduleRaw.timeZone };
  } else throw new Error('invalid_topic_schedule');
  const config: TopicSearchConfig = {
    enabled: bool(r.enabled, false), allowedChatIds: [...new Set(allowed)], models,
    llmModelRef: r.llmModelRef === undefined || r.llmModelRef === null ? null : name(r.llmModelRef),
    embedding: { enabled: bool(embedding.enabled, false), modelRef: embedding.modelRef === undefined || embedding.modelRef === null ? null : name(embedding.modelRef) }, schedule,
    initialLookbackDays: integer(r.initialLookbackDays, 14, 1, 3650),
    maxConcurrentTopics: integer(r.maxConcurrentTopics, 1, 1, 8), maxTopicsPerRun: integer(r.maxTopicsPerRun, 20, 1, 500),
    maxPagesPerRead: integer(r.maxPagesPerRead, 50, 1, 1000), maxMessagesPerBatch: integer(r.maxMessagesPerBatch, 100, 1, 500),
    maxInputChars: integer(r.maxInputChars, 24_000, 256, 128_000), maxOldSummaries: integer(r.maxOldSummaries, 20, 0, 100),
    maxAttempts: integer(r.maxAttempts, 3, 1, 10), retryBaseMs: integer(r.retryBaseMs, 30_000, 100, 3_600_000),
    jobTimeoutMs: integer(r.jobTimeoutMs, 120_000, 1000, 600_000), overlapHours: integer(r.overlapHours, 24, 1, 168),
    historicalRecheckDays: integer(r.historicalRecheckDays, 30, 1, 365), maxHistoricalChecksPerRun: integer(r.maxHistoricalChecksPerRun, 2, 0, 100),
    retentionDays: r.retentionDays === null || r.retentionDays === undefined ? null : integer(r.retentionDays, 365, 1, 3650),
  };
  if (config.enabled && (!config.llmModelRef || models[config.llmModelRef]?.adapter !== 'openai-chat')) throw new Error('topic_update_authorization_required');
  if (config.embedding.enabled && (!config.embedding.modelRef || models[config.embedding.modelRef]?.adapter !== 'openai-embeddings')) throw new Error('invalid_topic_embedding_model');
  return config;
}

/** Most recent due slot; handles arbitrarily long downtime without enumerating missed runs. */
export function topicScheduleSlot(schedule: TopicSchedule, now: number): string | null {
  if (!Number.isFinite(now)) throw new Error('invalid_topic_clock');
  const prefix = createHash('sha256').update(JSON.stringify(schedule)).digest('hex').slice(0, 16);
  if (schedule.kind === 'interval') return `${prefix}:${Math.floor(now / schedule.everyMs)}`;
  const cron = new Cron(schedule.expression, { timezone: schedule.timeZone, paused: true });
  const at = cron.previousRuns(1, new Date(Math.floor(now / 1000) * 1000 + 1000))[0];
  if (!at || at.getTime() > now) return null;
  // Local wall-clock identity collapses the repeated DST hour into one accepted slot.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return `${prefix}:${parts.filter(part => part.type !== 'literal').map(part => part.value).join('-')}`;
}
