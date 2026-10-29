import { describe, expect, it } from 'vitest';
import {
  isValidCronExpression,
  isValidTimeZone,
  resolveTopicSearchConfig,
  topicSearchBlockedReason,
  validateTopicSearchConfig,
  TOPIC_SEARCH_DEFAULT_CONFIG,
} from '../src/topic/config.js';

describe('话题检索配置校验', () => {
  it('缺省（没有 section）等价于全关，且不产生 issue', () => {
    const { config, issues } = resolveTopicSearchConfig(undefined);
    expect(config.enabled).toBe(false);
    expect(issues).toEqual([]);
    expect(config.embedding.enabled).toBe(false);
    expect(topicSearchBlockedReason(config)).toBe('disabled');
  });

  it('显式 enabled=false 与缺省同义', () => {
    const skipped = resolveTopicSearchConfig(undefined).config;
    const explicit = resolveTopicSearchConfig({ enabled: false }).config;
    expect(explicit).toEqual(skipped);
  });

  it('写错的 cron / 时区被拒绝，不会静默回落到默认值', () => {
    for (const schedule of [
      { kind: 'cron', expression: '0 2 * *' },
      { kind: 'cron', expression: 'every day' },
      { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shangai' },
      { kind: 'interval', intervalMinutes: 0 },
      { kind: 'interval', intervalMinutes: 5, timeZone: 'not-a-zone' },
      { kind: 'weekly' },
    ]) {
      const validation = validateTopicSearchConfig({ enabled: true, schedule });
      expect(validation.ok, JSON.stringify(schedule)).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);
    }
  });

  it('开启 embedding 但没有 modelRef 直接判非法（不等运行期才炸）', () => {
    const validation = validateTopicSearchConfig({ embedding: { enabled: true } });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map(issue => issue.field)).toContain('embedding.modelRef');
  });

  it('关掉 embedding 时不要求任何模型引用', () => {
    const validation = validateTopicSearchConfig({ embedding: { enabled: false, modelRef: null } });
    expect(validation.ok).toBe(true);
    expect(validation.value?.embedding).toEqual({ enabled: false, modelRef: null });
  });

  it('数值字段有上下界，越界报对应字段', () => {
    expect(validateTopicSearchConfig({ initialLookbackDays: 0 }).ok).toBe(false);
    expect(validateTopicSearchConfig({ maxTopicsPerRun: 10_000 }).ok).toBe(false);
    expect(validateTopicSearchConfig({ maxConcurrentTopics: 0 }).ok).toBe(false);
    const ok = validateTopicSearchConfig({ maxTopicsPerRun: 3, maxConcurrentTopics: 2, initialLookbackDays: 30 });
    expect(ok.value).toMatchObject({ maxTopicsPerRun: 3, maxConcurrentTopics: 2, initialLookbackDays: 30 });
  });

  it('allowedChatIds 去重并去掉空白，非字符串项判非法', () => {
    const deduped = validateTopicSearchConfig({ allowedChatIds: [' oc_1 ', 'oc_1', 'oc_2'] });
    expect(deduped.value?.allowedChatIds).toEqual(['oc_1', 'oc_2']);
    expect(validateTopicSearchConfig({ allowedChatIds: ['oc_1', 3] }).ok).toBe(false);
  });

  it('启用的先决条件是「群范围 + 摘要模型引用」，embedding 不在其中', () => {
    const base = resolveTopicSearchConfig({
      enabled: true,
      allowedChatIds: ['oc_1'],
      llmModelRef: 'topic-enricher',
    }).config;
    expect(topicSearchBlockedReason(base)).toBeNull();
    expect(topicSearchBlockedReason({ ...base, allowedChatIds: [] })).toBe('no_allowed_chats');
    expect(topicSearchBlockedReason({ ...base, llmModelRef: null })).toBe('no_llm_model_ref');
    expect(topicSearchBlockedReason({ ...base, embedding: { enabled: false, modelRef: null } })).toBeNull();
  });

  it('默认调度是带时区的每日 cron，不是「缺时区按本机跑」', () => {
    expect(TOPIC_SEARCH_DEFAULT_CONFIG.schedule.kind).toBe('cron');
    if (TOPIC_SEARCH_DEFAULT_CONFIG.schedule.kind === 'cron') {
      expect(isValidTimeZone(TOPIC_SEARCH_DEFAULT_CONFIG.schedule.timeZone)).toBe(true);
      expect(isValidCronExpression(TOPIC_SEARCH_DEFAULT_CONFIG.schedule.expression)).toBe(true);
    }
  });
});
