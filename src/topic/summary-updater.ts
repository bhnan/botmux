import type { Topic } from '../types.js';
import { parseTopicSearchConfig } from './config.js';
import { TopicModelClient, topicModelKey, type TopicModelInput } from './model-client.js';
import { readTopicIncrement, type TopicPageReader } from './source.js';
import { TopicStore } from './store.js';
import type { TopicExecutor, TopicExecutionContext } from './scheduler.js';

export interface TopicSummaryUpdaterDeps {
  store: TopicStore;
  model: Pick<TopicModelClient, 'summarize'>;
  source: (topic: Topic, context: TopicExecutionContext) => TopicPageReader;
  now: () => number;
}

/** All returned content is committed by the scheduler's fenced, atomic settlement. */
export function topicSummaryExecutor(deps: TopicSummaryUpdaterDeps): TopicExecutor {
  return async (claim, context) => {
    const config = parseTopicSearchConfig(JSON.parse(claim.job.snapshot));
    const profile = config.llmModelRef ? config.models[config.llmModelRef] : undefined;
    if (!profile) throw new Error('topic_model_not_configured');
    const now = new Date(deps.now()).toISOString();
    const topic = deps.store.beginSource(claim, config.initialLookbackDays, now);
    const coverageStartAt = topic.coverageStartAt!;
    const reader = deps.source(topic, context);
    const result = await readTopicIncrement(async (token, signal) => {
      context.assertAuthorized();
      try { return await reader(token, signal); }
      catch (error) {
        // A provider token is not durable authority. Restart traversal after a failed token read;
        // never reset the last successfully summarized message boundary.
        if (token && !signal.aborted) deps.store.saveSourceProgress(claim, null);
        throw error;
      }
    }, {
      cursor: topic.summarizedThroughCursor, checkpoint: deps.store.sourceCheckpoint(topic.topicKey),
      coverageStartAt, now: new Date(claim.job.acceptedAt).toISOString(), maxPages: config.maxPagesPerRead, maxMessages: config.maxMessagesPerBatch,
      maxChars: Math.max(1, Math.min(config.maxInputChars, profile.maxInputChars) - 2000), signal: context.signal,
      isRevision: message => deps.store.sourceChanged(topic.topicKey, message),
      observe: times => { deps.store.observe(topic.topicKey, { ...times, checkedAt: now }, claim); },
    });
    deps.store.reconcileSources(claim, result.inspected, now);
    if (!result.messages.length) {
      return { kind: 'source-progress', checkpoint: result.checkpoint, maxSteps: config.maxStepsPerTopic };
    }
    const refreshed = deps.store.read(topic.topicKey)!;
    const input: TopicModelInput = { title: topic.title, messages: result.messages.filter(message => !message.deleted), summaries: [] };
    // Favor relevant existing entries, but never silently drop new messages to fit old context.
    const words = new Set(input.messages.flatMap(message => message.text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []));
    const score = (summary: Topic['summaries'][number]) => summary.keywords.reduce((sum, word) => sum + (words.has(word.toLowerCase()) ? 1 : 0), 0);
    for (const summary of [...refreshed.summaries].sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, config.maxOldSummaries)) {
      const candidate = { id: summary.id, text: summary.text, keywords: summary.keywords, sourceMessageIds: summary.sourceMessageIds };
      input.summaries.push(candidate);
      if (JSON.stringify(input).length + 2000 > Math.min(config.maxInputChars, profile.maxInputChars)) { input.summaries.pop(); continue; }
    }
    context.assertAuthorized();
    const mutations = input.messages.length ? await deps.model.summarize(profile, input, context.signal) : [{ op: 'noop' as const }];
    context.signal.throwIfAborted();
    return {
      topicKey: topic.topicKey, expectedRevision: refreshed.revision, operationId: `job:${claim.job.id}:step:${claim.job.step}`,
      mutations, verifiedMessageIds: input.messages.map(message => message.id), cursor: result.cursor!,
      generatorKey: topicModelKey(profile), now: new Date(deps.now()).toISOString(), sourceCheckpoint: result.checkpoint,
      processedSources: result.messages,
      ...(config.embedding.enabled && config.embedding.modelRef ? { embeddingProfile: config.models[config.embedding.modelRef] } : {}),
      ...(result.partial ? { continuation: { maxSteps: config.maxStepsPerTopic } } : {}),
    };
  };
}
