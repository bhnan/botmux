/** 话题检索配置解析行为回归（spec §4）：
 *  - 全局配置宽松读：坏形状降级为「未配置」，不拖垮其它配置读取
 *  - 严格 resolver：默认关闭、无授权群范围拒绝启用、内联 apiKey 硬拒绝
 *  - 调度互斥/时区必须/区间越界；embedding 关闭不需要任何模型配置
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGlobalConfig, mergeGlobalConfig, invalidateGlobalConfigCache } from '../src/global-config.js';
import {
  resolveTopicSearchConfig,
  topicModelKey,
  TOPIC_SEARCH_DEFAULTS,
  type TopicSearchRawConfig,
} from '../src/topic/config.js';

let tempDir: string;
let configPath: string;
let prevConfigFile: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-config-test-'));
  configPath = join(tempDir, 'config.json');
  prevConfigFile = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = configPath;
});

afterEach(() => {
  if (prevConfigFile === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  else process.env.BOTMUX_GLOBAL_CONFIG_FILE = prevConfigFile;
  rmSync(tempDir, { recursive: true, force: true });
});

const validLlm = { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-mini', apiKeyEnv: 'TOPIC_LLM_KEY' };
const validCron = { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' };

function validRaw(overrides: Partial<TopicSearchRawConfig> = {}): TopicSearchRawConfig {
  return {
    enabled: true,
    allowedChatIds: ['oc_chat1', 'oc_chat2'],
    llm: validLlm,
    schedule: validCron,
    ...overrides,
  };
}

describe('resolveTopicSearchConfig（严格解析）', () => {
  it('未配置 / 未启用 / 缺授权群范围 ⇒ 一律 disabled 且给原因', () => {
    expect(resolveTopicSearchConfig(undefined)).toEqual({ enabled: false, reasons: ['topic_search_not_configured'] });
    expect(resolveTopicSearchConfig({ enabled: false })).toEqual({ enabled: false, reasons: ['topic_search_disabled'] });
    expect(resolveTopicSearchConfig({})).toEqual({ enabled: false, reasons: ['topic_search_disabled'] });
    const noChats = resolveTopicSearchConfig(validRaw({ allowedChatIds: [] }));
    expect(noChats.enabled).toBe(false);
    expect(noChats.reasons).toContain('topic_search_allowed_chat_ids_missing');
    // 全是非字符串也一样拒绝
    const garbage = resolveTopicSearchConfig(validRaw({ allowedChatIds: [1, 2] as unknown as string[] }));
    expect(garbage.reasons).toContain('topic_search_allowed_chat_ids_missing');
  });

  it('合法配置解析成功并应用默认值', () => {
    const result = resolveTopicSearchConfig(validRaw());
    expect(result.enabled).toBe(true);
    if (!result.enabled) return;
    expect(result.config.allowedChatIds).toEqual(['oc_chat1', 'oc_chat2']);
    expect(result.config.llm.model).toBe('gpt-mini');
    expect(result.config.embedding).toEqual({ enabled: false });
    expect(result.config.schedule).toEqual({ kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' });
    expect(result.config.initialLookbackDays).toBe(TOPIC_SEARCH_DEFAULTS.initialLookbackDays);
    expect(result.config.maxConcurrentTopics).toBe(TOPIC_SEARCH_DEFAULTS.maxConcurrentTopics);
    expect(result.config.maxTopicsPerRun).toBe(TOPIC_SEARCH_DEFAULTS.maxTopicsPerRun);
  });

  it('配置里内联 apiKey 是硬错误（凭证只允许 env 引用）', () => {
    const result = resolveTopicSearchConfig(validRaw({ llm: { ...validLlm, apiKey: 'sk-secret' } }));
    expect(result.enabled).toBe(false);
    expect(result.reasons).toContain('topic_search_llm_api_key_inline_forbidden');
  });

  it('非法 apiKeyEnv 名 / 非 http(s) baseUrl / 未知 provider 拒绝', () => {
    expect(resolveTopicSearchConfig(validRaw({ llm: { ...validLlm, apiKeyEnv: 'not a name!' } })).reasons).toContain('topic_search_llm_api_key_env_invalid');
    expect(resolveTopicSearchConfig(validRaw({ llm: { ...validLlm, baseUrl: 'ftp://x' } })).reasons).toContain('topic_search_llm_base_url_invalid');
    expect(resolveTopicSearchConfig(validRaw({ llm: { ...validLlm, provider: 'anthropic' } })).reasons).toContain('topic_search_llm_provider_unsupported');
  });

  it('调度：kind 非法拒绝；cron/fixed-time 必须配合法 IANA 时区；interval 下限 15 分钟', () => {
    expect(resolveTopicSearchConfig(validRaw({ schedule: { kind: 'weekly' } })).reasons).toContain('topic_search_schedule_kind_invalid');
    expect(resolveTopicSearchConfig(validRaw({ schedule: { kind: 'cron', expression: '0 2 * * *' } })).reasons).toContain('topic_search_schedule_time_zone_invalid');
    expect(resolveTopicSearchConfig(validRaw({ schedule: { kind: 'fixed-time', time: '02:30', timeZone: 'Mars/Olympus' } })).reasons).toContain('topic_search_schedule_time_zone_invalid');
    expect(resolveTopicSearchConfig(validRaw({ schedule: { kind: 'interval', intervalMinutes: 5 } })).reasons).toContain('topic_search_schedule_interval_invalid');
    const ok = resolveTopicSearchConfig(validRaw({ schedule: { kind: 'fixed-time', time: '02:30', timeZone: 'Asia/Shanghai' } }));
    expect(ok.enabled).toBe(true);
    const intervalOk = resolveTopicSearchConfig(validRaw({ schedule: { kind: 'interval', intervalMinutes: 30 } }));
    expect(intervalOk.enabled).toBe(true);
  });

  it('embedding：关闭时不需要任何模型配置；开启必须有 dimensions', () => {
    const off = resolveTopicSearchConfig(validRaw({ embedding: { enabled: false } }));
    expect(off.enabled).toBe(true);
    const noDims = resolveTopicSearchConfig(validRaw({ embedding: { enabled: true, model: { provider: 'openai-compatible', baseUrl: 'https://e.example.com', model: 'emb-1' } } }));
    expect(noDims.enabled).toBe(false);
    expect(noDims.reasons).toContain('topic_search_embedding_dimensions_invalid');
    const on = resolveTopicSearchConfig(validRaw({
      embedding: { enabled: true, model: { provider: 'openai-compatible', baseUrl: 'https://e.example.com', model: 'emb-1', dimensions: 512, modelRevision: 'v2' } },
    }));
    expect(on.enabled).toBe(true);
    if (!on.enabled) return;
    expect(on.config.embedding).toEqual({
      enabled: true,
      model: { provider: 'openai-compatible', baseUrl: 'https://e.example.com', model: 'emb-1', dimensions: 512, modelRevision: 'v2' },
    });
  });

  it('数值越界拒绝（lookback/并发/每轮话题数）', () => {
    expect(resolveTopicSearchConfig(validRaw({ initialLookbackDays: 0 })).reasons).toContain('topic_search_lookback_invalid');
    expect(resolveTopicSearchConfig(validRaw({ maxConcurrentTopics: 99 })).reasons).toContain('topic_search_concurrency_invalid');
    expect(resolveTopicSearchConfig(validRaw({ maxTopicsPerRun: 1.5 })).reasons).toContain('topic_search_topics_per_run_invalid');
  });

  it('topicModelKey 折叠 provider/model/revision/dimensions', () => {
    expect(topicModelKey({ provider: 'openai-compatible', baseUrl: 'https://x', model: 'm' })).toBe('openai-compatible/m');
    expect(topicModelKey({ provider: 'openai-compatible', baseUrl: 'https://x', model: 'emb', dimensions: 512, modelRevision: 'v2' })).toBe('openai-compatible/emb@v2:512');
  });
});

describe('全局配置宽松读（~/.botmux/config.json）', () => {
  it('topicSearch 块结构化白名单读取；坏形状丢弃为未配置', () => {
    writeFileSync(configPath, JSON.stringify({
      topicSearch: {
        enabled: true,
        allowedChatIds: ['oc_ok', 42, '  '],
        llm: { provider: 'openai-compatible', baseUrl: 'https://x/v1/', model: 'm', futureKey: 'keep-me' },
        schedule: { kind: 'interval', intervalMinutes: 30 },
        initialLookbackDays: 30,
        maxConcurrentTopics: 2,
        maxTopicsPerRun: 'bogus',
      },
      lang: 'zh-CN',
    }), 'utf-8');
    const config = readGlobalConfig();
    expect(config.topicSearch).toBeDefined();
    expect(config.topicSearch?.allowedChatIds).toEqual(['oc_ok']);
    expect(config.topicSearch?.llm?.futureKey).toBe('keep-me');
    expect(config.topicSearch?.initialLookbackDays).toBe(30);
    expect(config.topicSearch?.maxTopicsPerRun).toBeUndefined();
    expect(config.topicSearch?.maxConcurrentTopics).toBe(2);
    // 宽松块仍要过严格 resolver 才能启用（baseUrl 保留尾斜杠由 resolver 归一）
    const resolved = resolveTopicSearchConfig(config.topicSearch as TopicSearchRawConfig);
    expect(resolved.enabled).toBe(true);

    writeFileSync(configPath, JSON.stringify({ topicSearch: 'garbage' }), 'utf-8');
    invalidateGlobalConfigCache(); // 直写文件不走 mergeGlobalConfig，显式失效 2s 读缓存
    expect(readGlobalConfig().topicSearch).toBeUndefined();
    writeFileSync(configPath, JSON.stringify({ topicSearch: { garbage: 1 } }), 'utf-8');
    invalidateGlobalConfigCache();
    expect(readGlobalConfig().topicSearch).toBeUndefined();
  });

  it('mergeGlobalConfig 写回后可读回（保留未知兄弟键）', () => {
    writeFileSync(configPath, JSON.stringify({ topicSearch: { enabled: true }, unknownFuture: { x: 1 } }), 'utf-8');
    mergeGlobalConfig({ topicSearch: { enabled: true, allowedChatIds: ['oc_1'] } });
    const config = readGlobalConfig();
    expect(config.topicSearch?.allowedChatIds).toEqual(['oc_1']);
    expect((JSON.parse(JSON.stringify(config)) as Record<string, unknown>).unknownFuture ?? true).toBeTruthy();
  });
});
