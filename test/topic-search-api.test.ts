import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cliAuthBind, signCliAuth } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { TopicSearchError } from '../src/topic/search.js';
import type { TopicRuntime } from '../src/topic/runtime.js';
import {
  startTopicSearchApi,
  topicSearchEndpointPath,
  TOPIC_SEARCH_HEALTH_PATH,
  TOPIC_SEARCH_PATH,
  type TopicSearchApiHandle,
} from '../src/dashboard/topic-search-api.js';

const SECRET = 'test-dashboard-secret';

function fakeRuntime(overrides: {
  enabled?: boolean;
  allowedChatIds?: string[];
  search?: (query: unknown, caller: unknown) => Promise<unknown>;
} = {}): TopicRuntime {
  const enabled = overrides.enabled ?? true;
  const allowedChatIds = overrides.allowedChatIds ?? ['oc_1'];
  return {
    config: () => ({
      config: { enabled, allowedChatIds },
      issues: [],
    }),
    search: vi.fn(
      overrides.search ??
        (async () => ({
          items: [
            { topicKey: 'thread:oc_1:om_1', title: '话题', matches: [], updatedAt: '2026-10-01T00:00:00.000Z' },
          ],
          effectiveMode: 'keyword',
          degradedReasons: [],
          coverage: { state: 'complete', unindexedKnownTopics: 0 },
          nextCursor: null,
        })),
    ),
  } as unknown as TopicRuntime;
}

function signedHeaders(port: number, secret = SECRET): HeadersInit {
  const auth = signCliAuth(secret, cliAuthBind('POST', TOPIC_SEARCH_PATH, port));
  return {
    'content-type': 'application/json',
    'x-botmux-cli-ts': auth.ts,
    'x-botmux-cli-nonce': auth.nonce,
    'x-botmux-cli-auth': auth.sig,
  };
}

let handle: TopicSearchApiHandle | undefined;
let dir: string;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('本机检索端点', () => {
  it('写端点发现文件，关闭时删除', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
    handle = await startTopicSearchApi({ runtime: fakeRuntime(), dataDir: dir, secret: SECRET });
    expect(handle.port).toBeGreaterThan(0);
    const endpointPath = topicSearchEndpointPath(dir);
    expect(existsSync(endpointPath)).toBe(true);
    await handle.close();
    handle = undefined;
    expect(existsSync(endpointPath)).toBe(false);
  });

  it('缺少签名头或签名不对一律 401', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
    handle = await startTopicSearchApi({ runtime: fakeRuntime(), dataDir: dir, secret: SECRET });
    const url = `http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`;

    const noHeaders = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"query":"owner"}',
    });
    expect(noHeaders.status).toBe(401);

    const badSig = await loopbackFetch(url, {
      method: 'POST',
      headers: signedHeaders(handle.port, 'a-different-secret'),
      body: '{"query":"owner"}',
    });
    expect(badSig.status).toBe(401);
    expect((await badSig.json()).reason).toBe('sig_mismatch');
  });

  it('签名正确时返回检索结果；健康检查不需要签名', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
    const runtime = fakeRuntime();
    handle = await startTopicSearchApi({ runtime, dataDir: dir, secret: SECRET });

    const health = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_HEALTH_PATH}`, {
      method: 'GET',
    });
    expect(health.status).toBe(200);

    const response = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`, {
      method: 'POST',
      headers: signedHeaders(handle.port),
      body: JSON.stringify({ query: 'owner', mode: 'keyword', limit: 3 }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; items: unknown[]; effectiveMode: string };
    expect(payload.ok).toBe(true);
    expect(payload.items).toHaveLength(1);
    expect(payload.effectiveMode).toBe('keyword');
    expect(runtime.search).toHaveBeenCalledWith({ query: 'owner', mode: 'keyword', limit: 3 }, { allowedChatIds: ['oc_1'] });
  });

  it('功能未启用返回 403，非法查询返回 400，越权过滤返回 403', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
    handle = await startTopicSearchApi({
      runtime: fakeRuntime({ enabled: false }),
      dataDir: dir,
      secret: SECRET,
    });
    const disabled = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`, {
      method: 'POST',
      headers: signedHeaders(handle.port),
      body: '{"query":"owner"}',
    });
    expect(disabled.status).toBe(403);
    await handle.close();
    handle = undefined;

    handle = await startTopicSearchApi({
      runtime: fakeRuntime({
        search: async () => {
          throw new TopicSearchError('forbidden', 'nope');
        },
      }),
      dataDir: dir,
      secret: SECRET,
    });
    const forbidden = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`, {
      method: 'POST',
      headers: signedHeaders(handle.port),
      body: '{"query":"owner","filters":{"chatIds":["oc_9"]}}',
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe('forbidden');

    const invalid = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`, {
      method: 'POST',
      headers: signedHeaders(handle.port),
      body: '{"query":""}',
    });
    expect(invalid.status).toBe(400);
  });

  it('其它路径 404，GET 检索路径 405', async () => {
    dir = mkdtempSync(join(tmpdir(), 'topic-api-test-'));
    handle = await startTopicSearchApi({ runtime: fakeRuntime(), dataDir: dir, secret: SECRET });
    const notFound = await loopbackFetch(`http://127.0.0.1:${handle.port}/api/nope`, { method: 'GET' });
    expect(notFound.status).toBe(404);
    const wrongMethod = await loopbackFetch(`http://127.0.0.1:${handle.port}${TOPIC_SEARCH_PATH}`, {
      method: 'GET',
    });
    expect(wrongMethod.status).toBe(405);
  });
});
