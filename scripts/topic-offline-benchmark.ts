/** Synthetic, deterministic-content scale fixture. Only a private ephemeral loopback HTTP server;
 * no daemon, live database, Lark, credentials or real embedding provider is used. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, platform, arch, release } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { TopicStore } from '../src/topic/store.js';
import { TopicSearchService, type TopicSearchResponse } from '../src/topic/search.js';
import { topicSearchApi } from '../src/dashboard/topic-search-api.js';
import { parseTopicSearchConfig } from '../src/topic/config.js';
import { encodeCursor } from '../src/topic/source.js';
import { topicModelKey } from '../src/topic/model-client.js';
import { contentHash } from '../src/topic/store.js';
import { sessionSearchText } from '../src/dashboard/web/sessions.js';
import { topicBenchmarkCases } from '../test/fixtures/topic-search/benchmark-cases.js';

const output = resolve(process.argv[2] ?? '/tmp/astra-topic-offline/benchmark');
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'topic-scale-fixture-'));
const originalFetch = globalThis.fetch;
let forbiddenFetches = 0, embeddingCalls = 0;
globalThis.fetch = async () => { forbiddenFetches++; throw new Error('offline_benchmark_forbids_provider_fetch'); };
const store = new TopicStore(join(directory, 'topics.sqlite'));
const config = parseTopicSearchConfig({ enabled: true, allowedChatIds: [], llmModelRef: 'summary', embedding: { enabled: true, modelRef: 'embedding' }, models: {
  summary: { adapter: 'openai-chat', endpoint: 'https://offline.invalid/v1', model: 'fixture-only', credentialRef: 'env:BOTMUX_TOPIC_FIXTURE' },
  embedding: { adapter: 'openai-embeddings', endpoint: 'https://offline.invalid/v1', model: 'manual-label-fixture', credentialRef: 'env:BOTMUX_TOPIC_FIXTURE', dimensions: 256, version: '1' },
} });
const vector = (axis: number) => Array.from({ length: 256 }, (_, i) => i === axis ? 1 : 0);
const modelKey = topicModelKey(config.models.embedding), at = '2026-10-01T00:00:00.000Z';
const rows: Array<{ topicKey: string; title: string; sessionId: string; chatId: string; rootMessageId: string; cliId: string }> = [];
const corpusHash = createHash('sha256');
const service = new TopicSearchService(store, () => config, { embed: async (_profile, query) => {
  embeddingCalls++;
  const index = topicBenchmarkCases.findIndex(item => item[0] === query);
  // Deliberately idealized labels test RRF/vector plumbing and scale, NOT model semantic quality.
  await new Promise(resolve => setTimeout(resolve, 10));
  return vector(index < 0 ? 20 : index);
} });
const server = createServer(async (req, res) => {
  const started = performance.now();
  try {
    if (req.method !== 'POST' || req.url !== '/offline-query') { res.writeHead(404).end(); return; }
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 8192) throw new Error('large request'); }
    const { query, mode } = JSON.parse(text) as { query: string; mode: string };
    const result = mode === 'baseline'
      ? { status: 200, body: { items: rows.filter(row => sessionSearchText(row).includes(query.toLowerCase())).slice(0, 3).map(row => ({ topicKey: row.topicKey })) } }
      : await topicSearchApi({ query, mode, limit: 3 }, { canManageHost: true, principal: 'offline-fixture' }, service);
    const serialized = JSON.stringify(result.body);
    res.writeHead(result.status, { 'content-type': 'application/json', 'x-fixture-server-ms': String(performance.now() - started) }).end(serialized);
  } catch { res.writeHead(500).end('{}'); }
});
try {
  for (let i = 0; i < 1000; i++) {
    const fixture = topicBenchmarkCases[i], title = fixture?.[1] ?? `模块 ${i} 日常工作记录`;
    const topic = store.discover({ chatId: `oc_group${i % 10}`, rootMessageId: `om_topic${i}`, title, accessPolicyRef: 'offline', larkThreadId: `omt_topic${i}` }, at);
    const sources = Array.from({ length: 10 }, (_, n) => ({ id: `om_source${i}_${n}`, text: fixture ? `${fixture[2]} 复核记录 ${n + 1}。` : `项目模块 ${i} 的工作记录 ${n + 1}：检查构建输出、整理变更记录、确认接口输入和测试结果。`, createdAt: at }));
    store.commit({ topicKey: topic.topicKey, expectedRevision: topic.revision, operationId: 'fixture-v1', now: at, generatorKey: 'authored-fixture', verifiedMessageIds: sources.map(source => source.id), processedSources: sources, cursor: encodeCursor({ time: at, ids: sources.map(source => source.id) }), mutations: sources.map(source => ({ op: 'add', text: source.text, keywords: fixture ? [...fixture[3]] : ['工作记录', `模块${i}`], sourceMessageIds: [source.id] })) });
    for (const summary of store.read(topic.topicKey)!.summaries) store.saveEmbedding(topic.topicKey, summary.id, { modelKey, contentHash: contentHash(summary.text), vector: vector(fixture ? i : 20) });
    corpusHash.update(JSON.stringify([topic.topicKey, title, sources]));
    rows.push({ topicKey: topic.topicKey, title, sessionId: `fixture${i}`, chatId: topic.chatId, rootMessageId: topic.rootMessageId, cliId: i % 2 ? 'claude' : 'codex' });
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing fixture port');
  const port = address.port;
  const call = (query: string, mode: string) => new Promise<{ response: TopicSearchResponse; serverMs: number; roundtripMs: number }>((resolve, reject) => {
    const start = performance.now(), body = JSON.stringify({ query, mode });
    // This is the sole HTTP client call: fixed loopback address and this newly allocated port.
    const req = request({ hostname: '127.0.0.1', port, path: '/offline-query', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`fixture_http_${res.statusCode}`)); return; }
        resolve({ response: JSON.parse(data), serverMs: Number(res.headers['x-fixture-server-ms']), roundtripMs: performance.now() - start });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('fixture deadline'))); req.on('error', reject); req.end(body);
  });
  const measurements: Array<{ mode: string; query: string; hit: boolean; serverMs: number; roundtripMs: number; examinedTopics: number; budgetLimited: boolean }> = [];
  for (const mode of ['baseline', 'keyword', 'hybrid']) for (let i = 0; i < topicBenchmarkCases.length; i++) {
    const query = topicBenchmarkCases[i][0], expected = rows[i].topicKey, sample = await call(query, mode);
    measurements.push({ mode, query, hit: sample.response.items.some(item => item.topicKey === expected), serverMs: sample.serverMs, roundtripMs: sample.roundtripMs, examinedTopics: sample.response.coverage?.examinedTopics ?? 0, budgetLimited: sample.response.coverage?.budgetLimited ?? false });
  }
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const report = { fixture: 'authored-synthetic-v1', corpusContentSha256: corpusHash.digest('hex'), topics: 1000, summaries: 10000, queries: topicBenchmarkCases.length,
    limits: 'Authored relevance labels, no human production-query confirmation. Hybrid vectors are idealized manual labels; not a real embedding quality/cost result. Isolated HTTP fixture reuses production API/search but not the full Dashboard process.',
    environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, runtime: process.version, bun: (process.versions as Record<string, string>).bun ?? null },
    groups: ['baseline', 'keyword', 'hybrid'].map(mode => { const group = measurements.filter(row => row.mode === mode); return { mode, top3: group.filter(row => row.hit).length / group.length, serverP50Ms: percentile(group.map(row => row.serverMs), .5), serverP95Ms: percentile(group.map(row => row.serverMs), .95), roundtripP95Ms: percentile(group.map(row => row.roundtripMs), .95), budgetLimitedQueries: group.filter(row => row.budgetLimited).length }; }),
    embeddingCalls, realProviderCalls: 0, sourceCalls: 0, forbiddenFetches, rssBytesAtEnd: process.memoryUsage().rss, measurements };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, measurements: undefined }, null, 2));
  if (forbiddenFetches) throw new Error('unexpected network attempt');
} finally {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true });
}
