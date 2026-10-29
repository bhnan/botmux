/**
 * 话题检索的配置解析与校验。
 *
 * 该节的语义是「缺省全关」：老配置里没有 `topicSearch` 时，一切后台扫描、模型
 * 调用、loopback 端点都不启动；`enabled: false` 与「没写」等价（见
 * `resolveTopicSearchConfig`）。
 *
 * 配置校验集中在这里，是因为写入入口有两个（`botmux topic config set` 与将来的
 * Dashboard 表单）：两边都必须过同一套规则，否则会出现「命令行写进去的 cron
 * 只有 Dashboard 读得懂」这种分裂。校验结果只报**错误码 + 字段名**，不回显凭证，
 * 也不把用户输入拼进错误消息（配置里可能有 endpoint 与密钥引用）。
 */

/** cron 表达式（5 段：分 时 日 月 周）。 */
export interface TopicSearchCronSchedule {
  kind: 'cron';
  expression: string;
  /** 固定时间必须带 IANA 时区；缺省用宿主本地时区会让「每天 2 点」在换机器后漂移。 */
  timeZone: string;
}

/** 周期调度（分钟）。 */
export interface TopicSearchIntervalSchedule {
  kind: 'interval';
  intervalMinutes: number;
  timeZone?: string;
}

export type TopicSearchSchedule = TopicSearchCronSchedule | TopicSearchIntervalSchedule;

/** 写入侧的 schedule 补丁形状（字段可选、kind 不取交集）。 */
export interface TopicSearchSchedulePatch {
  kind?: 'cron' | 'interval';
  expression?: string;
  timeZone?: string;
  intervalMinutes?: number;
}

/** `~/.botmux/config.json` 里的 `topicSearch` 节（可选字段，写入侧可只给一部分）。 */
export interface TopicSearchGlobalConfig {
  enabled?: boolean;
  allowedChatIds?: string[];
  llmModelRef?: string | null;
  embedding?: { enabled?: boolean; modelRef?: string | null };
  schedule?: TopicSearchSchedulePatch;
  initialLookbackDays?: number;
  maxConcurrentTopics?: number;
  maxTopicsPerRun?: number;
  /** 删除核查窗口（小时）；0 = 关闭缺席判定，只处理源侧显式删标记。 */
  recheckOverlapHours?: number;
}

/** 解析后的完整配置（默认值已填好，可直接消费）。 */
export interface ResolvedTopicSearchConfig {
  enabled: boolean;
  allowedChatIds: string[];
  llmModelRef: string | null;
  embedding: { enabled: boolean; modelRef: string | null };
  schedule: TopicSearchSchedule;
  initialLookbackDays: number;
  maxConcurrentTopics: number;
  maxTopicsPerRun: number;
  recheckOverlapHours: number;
}

export const TOPIC_SEARCH_DEFAULT_SCHEDULE: TopicSearchCronSchedule = {
  kind: 'cron',
  expression: '0 2 * * *',
  timeZone: 'Asia/Shanghai',
};

export const TOPIC_SEARCH_DEFAULT_LOOKBACK_DAYS = 14;
export const TOPIC_SEARCH_MAX_LOOKBACK_DAYS = 3650;
export const TOPIC_SEARCH_MAX_TOPICS_PER_RUN_CEILING = 200;
export const TOPIC_SEARCH_MAX_CONCURRENT_CEILING = 8;
export const TOPIC_SEARCH_MAX_RECHECK_OVERLAP_HOURS = 720;

export const TOPIC_SEARCH_DEFAULT_CONFIG: ResolvedTopicSearchConfig = {
  enabled: false,
  allowedChatIds: [],
  llmModelRef: null,
  embedding: { enabled: false, modelRef: null },
  schedule: TOPIC_SEARCH_DEFAULT_SCHEDULE,
  initialLookbackDays: TOPIC_SEARCH_DEFAULT_LOOKBACK_DAYS,
  maxConcurrentTopics: 1,
  maxTopicsPerRun: 20,
  recheckOverlapHours: 24,
};

export type TopicSearchConfigErrorCode =
  | 'invalid_enabled'
  | 'invalid_allowed_chat_ids'
  | 'invalid_llm_model_ref'
  | 'invalid_embedding'
  | 'invalid_schedule_kind'
  | 'invalid_schedule_expression'
  | 'invalid_schedule_timezone'
  | 'invalid_schedule_interval'
  | 'invalid_lookback_days'
  | 'invalid_max_concurrent_topics'
  | 'invalid_max_topics_per_run'
  | 'invalid_recheck_overlap_hours';

export interface TopicSearchConfigIssue {
  code: TopicSearchConfigErrorCode;
  field: string;
}

export interface TopicSearchConfigValidation {
  ok: boolean;
  issues: TopicSearchConfigIssue[];
  /** 归一化后的值：只有 `ok` 时才有意义；失败时不返回半成品。 */
  value?: ResolvedTopicSearchConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** cron 的 5 段形状校验（不解释语义，只挡明显写错的输入）。 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(field => /^[0-9*/,-]+$/.test(field));
}

/** IANA 时区校验：`Intl.DateTimeFormat` 认不出来的时区直接拒绝，
 *  避免把 `Asia/Shangai` 这类拼错带到调度里（croner 会静默按本地时区跑）。 */
export function isValidTimeZone(timeZone: string): boolean {
  const value = timeZone.trim();
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readPositiveInt(
  raw: unknown,
  options: { min: number; max: number },
): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = Math.floor(raw);
  if (value < options.min || value > options.max) return null;
  return value;
}

function readSchedule(
  raw: unknown,
  issues: TopicSearchConfigIssue[],
): TopicSearchSchedule | undefined {
  if (raw === undefined) return { ...TOPIC_SEARCH_DEFAULT_SCHEDULE };
  if (!isPlainObject(raw)) {
    issues.push({ code: 'invalid_schedule_kind', field: 'schedule' });
    return undefined;
  }
  const kind = raw.kind === undefined ? 'cron' : raw.kind;
  if (kind === 'interval') {
    const intervalMinutes = readPositiveInt(raw.intervalMinutes, { min: 1, max: 7 * 24 * 60 });
    if (intervalMinutes === null) {
      issues.push({ code: 'invalid_schedule_interval', field: 'schedule.intervalMinutes' });
      return undefined;
    }
    const timeZone = nonEmptyString(raw.timeZone);
    if (timeZone && !isValidTimeZone(timeZone)) {
      issues.push({ code: 'invalid_schedule_timezone', field: 'schedule.timeZone' });
      return undefined;
    }
    return timeZone ? { kind: 'interval', intervalMinutes, timeZone } : { kind: 'interval', intervalMinutes };
  }
  if (kind !== 'cron') {
    issues.push({ code: 'invalid_schedule_kind', field: 'schedule.kind' });
    return undefined;
  }
  const expression =
    raw.expression === undefined ? TOPIC_SEARCH_DEFAULT_SCHEDULE.expression : nonEmptyString(raw.expression);
  if (!isValidCronExpression(expression)) {
    issues.push({ code: 'invalid_schedule_expression', field: 'schedule.expression' });
    return undefined;
  }
  const timeZone =
    raw.timeZone === undefined ? TOPIC_SEARCH_DEFAULT_SCHEDULE.timeZone : nonEmptyString(raw.timeZone);
  if (!isValidTimeZone(timeZone)) {
    issues.push({ code: 'invalid_schedule_timezone', field: 'schedule.timeZone' });
    return undefined;
  }
  return { kind: 'cron', expression, timeZone };
}

/**
 * 归一化并校验一整节配置。
 *
 * 与仓库其它配置节的差别：这里**不做「无效值静默丢弃」**，因为一个写错的 cron
 * 静默回落到默认值会让管理员以为「每天 2 点」已经生效。所有不支持的值都产出一个
 * issue，由调用方决定是拒绝写入（配置命令）还是拒绝启动（runtime）。
 */
export function validateTopicSearchConfig(raw: unknown): TopicSearchConfigValidation {
  const issues: TopicSearchConfigIssue[] = [];
  if (raw !== undefined && !isPlainObject(raw)) {
    return { ok: false, issues: [{ code: 'invalid_enabled', field: 'topicSearch' }] };
  }
  const section = isPlainObject(raw) ? raw : {};

  let enabled = false;
  if (section.enabled !== undefined) {
    if (typeof section.enabled !== 'boolean') {
      issues.push({ code: 'invalid_enabled', field: 'enabled' });
    } else {
      enabled = section.enabled;
    }
  }

  let allowedChatIds: string[] = [];
  if (section.allowedChatIds !== undefined) {
    if (
      !Array.isArray(section.allowedChatIds) ||
      section.allowedChatIds.some(id => typeof id !== 'string' || !id.trim())
    ) {
      issues.push({ code: 'invalid_allowed_chat_ids', field: 'allowedChatIds' });
    } else {
      allowedChatIds = [...new Set(section.allowedChatIds.map(id => id.trim()))];
    }
  }

  let llmModelRef: string | null = null;
  if (section.llmModelRef !== undefined) {
    if (section.llmModelRef === null) llmModelRef = null;
    else if (typeof section.llmModelRef === 'string' && section.llmModelRef.trim()) {
      llmModelRef = section.llmModelRef.trim();
    } else issues.push({ code: 'invalid_llm_model_ref', field: 'llmModelRef' });
  }

  const embedding = { enabled: false, modelRef: null as string | null };
  if (section.embedding !== undefined) {
    if (!isPlainObject(section.embedding)) {
      issues.push({ code: 'invalid_embedding', field: 'embedding' });
    } else {
      const rawEmbedding = section.embedding;
      if (rawEmbedding.enabled !== undefined) {
        if (typeof rawEmbedding.enabled !== 'boolean') {
          issues.push({ code: 'invalid_embedding', field: 'embedding.enabled' });
        } else embedding.enabled = rawEmbedding.enabled;
      }
      if (rawEmbedding.modelRef !== undefined) {
        if (rawEmbedding.modelRef === null) embedding.modelRef = null;
        else if (typeof rawEmbedding.modelRef === 'string' && rawEmbedding.modelRef.trim()) {
          embedding.modelRef = rawEmbedding.modelRef.trim();
        } else issues.push({ code: 'invalid_embedding', field: 'embedding.modelRef' });
      }
    }
  }
  if (embedding.enabled && !embedding.modelRef) {
    // 开了 embedding 却没有模型引用必然发不出请求；这里就报错，不等运行期。
    issues.push({ code: 'invalid_embedding', field: 'embedding.modelRef' });
  }

  const schedule = readSchedule(section.schedule, issues);

  let initialLookbackDays = TOPIC_SEARCH_DEFAULT_LOOKBACK_DAYS;
  if (section.initialLookbackDays !== undefined) {
    const value = readPositiveInt(section.initialLookbackDays, { min: 1, max: TOPIC_SEARCH_MAX_LOOKBACK_DAYS });
    if (value === null) issues.push({ code: 'invalid_lookback_days', field: 'initialLookbackDays' });
    else initialLookbackDays = value;
  }

  let maxConcurrentTopics = TOPIC_SEARCH_DEFAULT_CONFIG.maxConcurrentTopics;
  if (section.maxConcurrentTopics !== undefined) {
    const value = readPositiveInt(section.maxConcurrentTopics, { min: 1, max: TOPIC_SEARCH_MAX_CONCURRENT_CEILING });
    if (value === null) issues.push({ code: 'invalid_max_concurrent_topics', field: 'maxConcurrentTopics' });
    else maxConcurrentTopics = value;
  }

  let recheckOverlapHours = TOPIC_SEARCH_DEFAULT_CONFIG.recheckOverlapHours;
  if (section.recheckOverlapHours !== undefined) {
    const value = readPositiveInt(section.recheckOverlapHours, {
      min: 0,
      max: TOPIC_SEARCH_MAX_RECHECK_OVERLAP_HOURS,
    });
    if (value === null) issues.push({ code: 'invalid_recheck_overlap_hours', field: 'recheckOverlapHours' });
    else recheckOverlapHours = value;
  }

  let maxTopicsPerRun = TOPIC_SEARCH_DEFAULT_CONFIG.maxTopicsPerRun;
  if (section.maxTopicsPerRun !== undefined) {
    const value = readPositiveInt(section.maxTopicsPerRun, {
      min: 1,
      max: TOPIC_SEARCH_MAX_TOPICS_PER_RUN_CEILING,
    });
    if (value === null) issues.push({ code: 'invalid_max_topics_per_run', field: 'maxTopicsPerRun' });
    else maxTopicsPerRun = value;
  }

  if (issues.length > 0 || !schedule) return { ok: false, issues };

  return {
    ok: true,
    issues: [],
    value: {
      enabled,
      allowedChatIds,
      llmModelRef,
      embedding,
      schedule,
      initialLookbackDays,
      maxConcurrentTopics,
      maxTopicsPerRun,
      recheckOverlapHours,
    },
  };
}

/**
 * 解析配置节 → 完整配置。无效输入按「未启用」处理（fail-closed），并保留 issues
 * 供调用方上报；不会抛异常，因为这个函数在宿主启动路径上被调用。
 */
export function resolveTopicSearchConfig(raw: unknown): {
  config: ResolvedTopicSearchConfig;
  issues: TopicSearchConfigIssue[];
} {
  const validation = validateTopicSearchConfig(raw);
  if (!validation.ok) {
    return {
      config: { ...TOPIC_SEARCH_DEFAULT_CONFIG, enabled: false },
      issues: validation.issues,
    };
  }
  return { config: validation.value!, issues: [] };
}

/** 启用的最小前提：enabled + 至少一个授权群 + 已配置摘要模型引用。
 *  embedding 不是前提（关闭时走关键词检索）。 */
export function topicSearchBlockedReason(config: ResolvedTopicSearchConfig): string | null {
  if (!config.enabled) return 'disabled';
  if (config.allowedChatIds.length === 0) return 'no_allowed_chats';
  if (!config.llmModelRef) return 'no_llm_model_ref';
  return null;
}
