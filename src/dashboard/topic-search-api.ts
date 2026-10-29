/**
 * 话题检索的宿主侧对外接口（**只绑 loopback**）。
 *
 * 为什么不挂在 dashboard 主监听器上：主监听器默认 `0.0.0.0`，把检索挂上去等于把
 * 「话题摘要」暴露到网络面；这里是独立 listener，bind 固定 127.0.0.1、端口动态分配。
 *
 * 鉴权复用现有 CLI 轮换 HMAC（`dashboard/auth.ts` 的 `signCliAuth`/`verifyHmac`，
 * 绑定 method+path+port），**不新造一套 token**，也不分发 dashboard 全局管理 token：
 * - 远端地址非 loopback → 401
 * - 时间窗/重放/签名不符 → 401
 * - 功能未启用 → 403
 * - 越权 chat 范围 → 403
 *
 * 端点发现：`<dataDir>/topic-search-endpoint.json`（0600），CLI 侧只读它拿端口。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { isLoopbackPeer } from '../utils/loopback-peers.js';
import { loadDashboardSecret, verifyHmac } from '../dashboard/auth.js';
import { TopicSearchError, type TopicSearchFilters, type TopicSearchMode, type TopicSearchQuery } from '../topic/search.js';
import type { TopicRuntime } from '../topic/runtime.js';

export const TOPIC_SEARCH_PATH = '/api/topic-search';
export const TOPIC_SEARCH_HEALTH_PATH = '/__health';
export const TOPIC_SEARCH_ENDPOINT_FILENAME = 'topic-search-endpoint.json';
const MAX_BODY_BYTES = 256 * 1024;

export interface TopicSearchEndpointInfo {
  version: 1;
  port: number;
  pid: number;
  startedAt: string;
}

export function topicSearchEndpointPath(dataDir: string = resolveBotmuxDataDir()): string {
  return join(dataDir, TOPIC_SEARCH_ENDPOINT_FILENAME);
}

export interface TopicSearchApiOptions {
  runtime: TopicRuntime;
  /** 宿主管理的数据目录（端点发现文件落在这里）。 */
  dataDir?: string;
  /** dashboard secret 路径（测试用；缺省 `~/.botmux/.dashboard-secret`）。 */
  secretPath?: string;
  /** 显式 secret（测试用；缺省从 secret 文件读取）。 */
  secret?: string;
  /** 调用者授权范围解析；缺省用当前配置里的 allowedChatIds（即本部署已索引的群）。 */
  resolveCallerChats?: (req: IncomingMessage) => readonly string[] | null;
  now?: () => string;
}

export interface TopicSearchApiHandle {
  port: number;
  close(): Promise<void>;
}

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readHeaderValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return '';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw Object.assign(new Error('body too large'), { code: 'body_too_large' });
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { code: 'invalid_json' });
  }
}

function parseQuery(body: unknown): TopicSearchQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TopicSearchError('invalid_query', 'body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const filtersRaw = record.filters;
  let filters: TopicSearchFilters | undefined;
  if (filtersRaw !== undefined) {
    if (!filtersRaw || typeof filtersRaw !== 'object' || Array.isArray(filtersRaw)) {
      throw new TopicSearchError('invalid_filter', 'filters must be an object');
    }
    const rawFilters = filtersRaw as Record<string, unknown>;
    filters = {
      ...(rawFilters.chatIds === undefined
        ? {}
        : Array.isArray(rawFilters.chatIds) && rawFilters.chatIds.every(id => typeof id === 'string')
          ? { chatIds: rawFilters.chatIds as string[] }
          : (() => {
              throw new TopicSearchError('invalid_filter', 'filters.chatIds must be string[]');
            })()),
      ...(rawFilters.sourceFrom === undefined ? {} : { sourceFrom: rawFilters.sourceFrom as string | null }),
      ...(rawFilters.sourceTo === undefined ? {} : { sourceTo: rawFilters.sourceTo as string | null }),
    };
  }
  const mode = record.mode;
  if (mode !== undefined && mode !== 'keyword' && mode !== 'hybrid' && mode !== 'auto') {
    throw new TopicSearchError('invalid_query', 'mode must be keyword/hybrid/auto');
  }
  if (record.limit !== undefined && typeof record.limit !== 'number') {
    throw new TopicSearchError('invalid_limit', 'limit must be a number');
  }
  if (record.cursor !== undefined && record.cursor !== null && typeof record.cursor !== 'string') {
    throw new TopicSearchError('invalid_cursor', 'cursor must be a string');
  }
  return {
    query: typeof record.query === 'string' ? record.query : '',
    ...(filters ? { filters } : {}),
    ...(mode ? { mode: mode as TopicSearchMode } : {}),
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor as string | null }),
  };
}

function statusForSearchError(error: TopicSearchError): number {
  switch (error.code) {
    case 'forbidden':
      return 403;
    case 'budget_exceeded':
      return 429;
    case 'invalid_query':
    case 'invalid_limit':
    case 'invalid_filter':
    case 'invalid_cursor':
    default:
      return 400;
  }
}

export async function startTopicSearchApi(options: TopicSearchApiOptions): Promise<TopicSearchApiHandle> {
  const dataDir = options.dataDir ?? resolveBotmuxDataDir();
  // 与 CLI 侧（core/daemon-ipc-auth.ts）读同一份 secret：这是唯一已在本机受保护的
  // 共享凭证，不新造一套。缺它直接拒绝启动，不回落到无鉴权。
  const secret =
    options.secret ??
    loadDashboardSecret(options.secretPath ?? join(homedir(), '.botmux', '.dashboard-secret'));
  if (!secret) {
    throw Object.assign(new Error('topic search api requires the dashboard secret'), {
      code: 'secret_unavailable',
    });
  }
  const now = options.now ?? (() => new Date().toISOString());
  let boundPort = 0;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      const remoteAddr = req.socket.remoteAddress ?? undefined;

      if (!isLoopbackPeer(remoteAddr)) {
        jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: 'remote_not_loopback' });
        return;
      }

      if (req.method === 'GET' && url.pathname === TOPIC_SEARCH_HEALTH_PATH) {
        jsonRes(res, 200, { ok: true, enabled: options.runtime.config().config.enabled });
        return;
      }

      if (url.pathname !== TOPIC_SEARCH_PATH) {
        jsonRes(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      if (req.method !== 'POST') {
        jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      const attempt = {
        ts: readHeaderValue(req, 'x-botmux-cli-ts'),
        nonce: readHeaderValue(req, 'x-botmux-cli-nonce'),
        sig: readHeaderValue(req, 'x-botmux-cli-auth'),
      };
      if (!attempt.ts || !attempt.nonce || !attempt.sig) {
        jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: 'missing_header' });
        return;
      }
      const verified = verifyHmac(
        secret,
        attempt,
        remoteAddr ?? '',
        `${req.method} ${url.pathname} ${boundPort}`,
      );
      if (!verified.ok) {
        jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: verified.reason });
        return;
      }

      const { config } = options.runtime.config();
      if (!config.enabled) {
        jsonRes(res, 403, { ok: false, error: 'disabled' });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'invalid_json';
        jsonRes(res, code === 'body_too_large' ? 413 : 400, { ok: false, error: code });
        return;
      }

      let query: TopicSearchQuery;
      try {
        query = parseQuery(body);
        // 空查询在这里就拒掉：别把 400 的语义拖到检索服务里（那会被映射成 503/403）。
        if (!query.query.trim()) throw new TopicSearchError('invalid_query', 'query must not be empty');
      } catch (error) {
        const searchError = error as TopicSearchError;
        jsonRes(res, statusForSearchError(searchError), { ok: false, error: searchError.code });
        return;
      }

      const callerChats = options.resolveCallerChats
        ? options.resolveCallerChats(req)
        : config.allowedChatIds;
      if (!callerChats) {
        jsonRes(res, 401, { ok: false, error: 'unauthorized', reason: 'caller_unresolved' });
        return;
      }

      try {
        const result = await options.runtime.search(query, { allowedChatIds: callerChats });
        jsonRes(res, 200, { ok: true, generatedAt: now(), ...result });
      } catch (error) {
        if (error instanceof TopicSearchError) {
          jsonRes(res, statusForSearchError(error), { ok: false, error: error.code });
          return;
        }
        // 内部错误不把细节回给调用方（可能含路径/模型信息）。
        jsonRes(res, 503, { ok: false, error: 'search_unavailable' });
      }
    })().catch(() => {
      try {
        jsonRes(res, 500, { ok: false, error: 'internal_error' });
      } catch {
        // 响应已经发出去或连接断了：忽略。
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  boundPort = typeof address === 'object' && address ? address.port : 0;

  const endpointPath = topicSearchEndpointPath(dataDir);
  const info: TopicSearchEndpointInfo = { version: 1, port: boundPort, pid: process.pid, startedAt: now() };
  try {
    writeFileSync(endpointPath, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // 发现文件写不进去：CLI 会退回「端口未知」的明确错误，接口本身仍可用于进程内调用。
  }

  return {
    port: boundPort,
    async close() {
      try {
        rmSync(endpointPath, { force: true });
      } catch {
        // 端点文件已不在：无妨。
      }
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
