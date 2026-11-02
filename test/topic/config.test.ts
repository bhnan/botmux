import { expect, it } from 'vitest';
import { parseTopicSearchConfig, topicScheduleSlot } from '../../src/topic/config.js';
import { mergeGlobalConfig, readGlobalConfig, invalidateGlobalConfigCache } from '../../src/global-config.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { globalConfigPath } from '../../src/global-config.js';

const model = { adapter: 'openai-chat', endpoint: 'https://model.invalid/v1', model: 'fake', credentialRef: 'env:BOTMUX_TOPIC_TEST_KEY' };
const valid = { enabled: true, allowedChatIds: ['oc_a'], llmModelRef: 'summary', models: { summary: model } };
it('defaults to disabled with no model or embedding credential requirement', () => {
  expect(parseTopicSearchConfig()).toMatchObject({ enabled: false, models: {}, embedding: { enabled: false, modelRef: null } });
});
it('requires independent provider authorization and explicit capabilities before enabling', () => {
  expect(() => parseTopicSearchConfig({ enabled: true })).toThrow('topic_update_authorization_required');
  expect(() => parseTopicSearchConfig({ ...valid, embedding: { enabled: true, modelRef: 'summary' } })).toThrow('invalid_topic_embedding_model');
  expect(parseTopicSearchConfig(valid).enabled).toBe(true);
});
it('allows removing every chat from update scope without disabling retained-content search', () => {
  expect(parseTopicSearchConfig({ ...valid, allowedChatIds: [] })).toMatchObject({ enabled: true, allowedChatIds: [] });
});
it.each([
  { ...model, apiKey: 'never-store-this' },
  { ...model, credentialRef: 'env:OPENAI_API_KEY' },
  { ...model, endpoint: 'https://username:password@model.invalid/v1' },
  { ...model, endpoint: 'http://model.invalid' },
  { ...model, endpoint: 'https://model.invalid/?key=secret' },
  { ...model, adapter: 'arbitrary-tools' },
])('rejects unsafe or ambiguous provider configuration', profile => {
  expect(() => parseTopicSearchConfig({ ...valid, models: { summary: profile } })).toThrow();
});
it.each([
  { maxConcurrentTopics: 0 }, { maxTopicsPerRun: 999999 }, { jobTimeoutMs: Infinity },
  { maxInputChars: 1.5 }, { allowedChatIds: ['*'] }, { enabled: 'yes' },
  { schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'not/a/zone' } },
  { schedule: { kind: 'interval', expression: '* * * * *', everyMs: 60_000 } },
  { schedule: { kind: 'cron', expression: '* * * * *', timeZone: 'UTC', everyMs: 60_000 } },
])('rejects invalid budgets, scope and conflicting schedules', patch => {
  expect(() => parseTopicSearchConfig({ ...valid, ...patch })).toThrow();
});
it('requires embedding model version/dimensions and never assumes a chat adapter can embed', () => {
  const embedding = { ...model, adapter: 'openai-embeddings' };
  expect(() => parseTopicSearchConfig({ models: { embed: embedding } })).toThrow('missing_topic_embedding_dimensions');
  expect(parseTopicSearchConfig({ embedding: { enabled: true, modelRef: 'embed' }, models: { embed: { ...embedding, dimensions: 2, version: '2' } } }).models.embed).toMatchObject({ dimensions: 2, version: '2' });
});
it('round-trips through the real global config file and malformed disk values fail closed', () => {
  const normalized = parseTopicSearchConfig(valid);
  mergeGlobalConfig({ topicSearch: normalized });
  expect(readGlobalConfig().topicSearch).toEqual(normalized);
  const path = globalConfigPath();
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...raw, topicSearch: { enabled: true, models: { summary: { apiKey: 'unsafe' } } } }));
  invalidateGlobalConfigCache();
  expect(readGlobalConfig().topicSearch?.enabled).toBe(false);
  expect(readGlobalConfig().topicSearch?.models).toEqual({});
});
it('coalesces long downtime into one current interval slot', () => {
  const schedule = parseTopicSearchConfig({ schedule: { kind: 'interval', everyMs: 60_000 } }).schedule;
  expect(topicScheduleSlot(schedule, 120_001)).toBe(topicScheduleSlot(schedule, 179_999));
  expect(topicScheduleSlot(schedule, 180_000)).not.toBe(topicScheduleSlot(schedule, 179_999));
});
it('resolves a cron slot in the configured zone rather than the machine zone', () => {
  const schedule = parseTopicSearchConfig({ schedule: { kind: 'cron', expression: '0 2 * * *', timeZone: 'Asia/Shanghai' } }).schedule;
  const before = topicScheduleSlot(schedule, Date.parse('2026-11-01T17:59:59Z'));
  const due = topicScheduleSlot(schedule, Date.parse('2026-11-01T18:00:00Z'));
  expect(due).not.toBe(before);
  expect(topicScheduleSlot(schedule, Date.parse('2026-11-02T17:59:59Z'))).toBe(due);
});
it('collapses the repeated DST wall time to one slot while preserving the next day', () => {
  const schedule = parseTopicSearchConfig({ schedule: { kind: 'cron', expression: '30 1 * * *', timeZone: 'America/New_York' } }).schedule;
  const first = topicScheduleSlot(schedule, Date.parse('2026-11-01T05:30:01Z'));
  expect(topicScheduleSlot(schedule, Date.parse('2026-11-01T06:30:01Z'))).toBe(first);
  expect(topicScheduleSlot(schedule, Date.parse('2026-11-02T06:30:01Z'))).not.toBe(first);
});
