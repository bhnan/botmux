/**
 * 话题知识模块的公共出口。
 *
 * 只导出宿主需要的东西（runtime / 查询服务 / 存储 / 身份 / 配置），内部实现细节
 * （prompt 拼装、SQL、分页）不外泄，避免别处绕开这里自己拼一套检索或 SQL。
 *
 * ⚠️ `identity.ts` 是唯一允许被浏览器 bundle 引用的模块（Dashboard 聚合用），其余
 * 模块都依赖 Node 运行时，不要在 `dashboard/web/` 里 import。
 */

export {
  isValidCronExpression,
  isValidTimeZone,
  resolveTopicSearchConfig,
  topicSearchBlockedReason,
  validateTopicSearchConfig,
  TOPIC_SEARCH_DEFAULT_CONFIG,
  TOPIC_SEARCH_DEFAULT_SCHEDULE,
  type ResolvedTopicSearchConfig,
  type TopicSearchConfigIssue,
  type TopicSearchConfigValidation,
  type TopicSearchGlobalConfig,
  type TopicSearchSchedule,
} from './config.js';
export {
  parseTopicKey,
  threadAnchorOf,
  threadTopicKey,
  topicFallbackTitle,
  topicKeyOf,
  topicScopeOf,
  type ParsedTopicKey,
  type ThreadTopicAnchor,
  type TopicAnchorFields,
  type TopicScope,
} from './identity.js';
export {
  createTopicSearchService,
  TopicSearchError,
  type TopicSearchCaller,
  type TopicSearchFilters,
  type TopicSearchItem,
  type TopicSearchMatch,
  type TopicSearchMode,
  type TopicSearchQuery,
  type TopicSearchResponse,
  type TopicSearchService,
} from './search.js';
export {
  computeNextRunAt,
  computeSlotId,
  createTopicScheduler,
  type TopicRunReport,
  type TopicScheduler,
  type TopicTickOutcome,
} from './scheduler.js';
export {
  decodeCursor,
  encodeCursor,
  normalizeSourceMessages,
  selectIncrement,
  type TopicDirectoryEntry,
  type TopicHistoryPage,
  type TopicHistoryReader,
  type TopicSourceCursor,
  type TopicSourceMessage,
} from './source.js';
export {
  resolveTopicEndpointsFromEnv,
  type TopicEnvEndpoints,
} from './endpoints.js';
export {
  createDaemonTopicSource,
  DAEMON_HISTORY_MAX_LIMIT,
  type DaemonHistoryMessage,
  type DaemonTopicSourceDeps,
  type TopicSourceSessionRow,
} from './daemon-source.js';
export {
  openTopicStore,
  TOPIC_STORE_FILENAME,
  topicStorePath,
  TopicStoreUnavailableError,
  type TopicStore,
  type TopicStore as TopicStoreHandle,
} from './store.js';
export {
  createTopicRuntime,
  buildTopicClients,
  type TopicRuntime,
  type TopicRuntimeDeps,
} from './runtime.js';
export {
  computeRetryAtIso,
  runEmbeddingBackfill,
  SUMMARY_UPDATE_DEFAULT_LIMITS,
  updateTopicFromSource,
  type SummaryUpdateLimits,
  type TopicUpdateOptions,
  type UpdateTopicOutcome,
} from './summary-updater.js';
export {
  createTopicEmbedder,
  topicEmbeddingModelKey,
  type TopicEmbedder,
  type TopicEmbeddingEndpoint,
} from './embedding-client.js';
export {
  createTopicEnricher,
  parseSummaryMutations,
  SUMMARY_PROMPT_VERSION,
  TopicModelError,
  type EnrichmentRequest,
  type EnrichmentResult,
  type SummaryMutation,
  type TopicEnricher,
  type TopicModelEndpoint,
} from './model-client.js';
export {
  cosineSimilarity,
  reciprocalRankFusion,
  summaryContentHash,
  validateEmbeddingVector,
} from './vector.js';
export { matchTopicByKeyword, normalizeKeywordText, tokenizeQuery } from './keyword.js';
