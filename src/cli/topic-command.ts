/**
 * `botmux topic …`：本机查询话题知识的 CLI 入口。
 *
 * 只做三件事：拼请求、签名转发、把结果原样打出来。**不直接读检索实现**——CLI 与
 * 直接 HTTP 调用共用同一个 SearchService（宿主进程里的那一份），否则两处会各自
 * 扫描数据库、各自实现一套降级/覆盖语义。
 *
 * 退出码沿用仓库约定：0 成功；1 用法/数据错误；2 拒绝执行（未知参数）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { readGlobalConfig, mergeGlobalConfig } from '../global-config.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { resolveTopicSearchConfig, validateTopicSearchConfig, type TopicSearchGlobalConfig } from '../topic/config.js';
import { openTopicStore, topicStorePath } from '../topic/store.js';
import {
  TOPIC_SEARCH_ENDPOINT_FILENAME,
  TOPIC_SEARCH_PATH,
} from '../dashboard/topic-search-api.js';

const VALUE_FLAGS = ['--mode', '--limit', '--chat', '--from', '--to', '--cursor', '--port', '--file'] as const;
const BOOL_FLAGS = ['--json'] as const;

function argValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) {
      const next = args[index + 1];
      if (next === undefined) return undefined;
      return next;
    }
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

function argValues(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) {
      const next = args[index + 1];
      if (next !== undefined) out.push(next);
      continue;
    }
    if (token.startsWith(`${flag}=`)) out.push(token.slice(flag.length + 1));
  }
  return out;
}

function unknownArgs(args: readonly string[], known: { valueFlags: readonly string[]; boolFlags: readonly string[] }): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (known.valueFlags.includes(token)) {
      index += 1;
      continue;
    }
    if (known.valueFlags.some(flag => token.startsWith(`${flag}=`))) continue;
    if (known.boolFlags.includes(token)) continue;
    if (token.startsWith('-')) out.push(token);
  }
  return out;
}

function firstPositional(args: readonly string[], valueFlags: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (valueFlags.includes(token)) {
      index += 1;
      continue;
    }
    if (valueFlags.some(flag => token.startsWith(`${flag}=`))) continue;
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

interface EndpointInfo {
  port: number;
}

function readEndpointInfo(): EndpointInfo | null {
  const path = join(resolveBotmuxDataDir(), TOPIC_SEARCH_ENDPOINT_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown };
    if (typeof parsed.port !== 'number' || !Number.isFinite(parsed.port)) return null;
    return { port: parsed.port };
  } catch {
    return null;
  }
}

function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

const SEARCH_ERROR_TEXT: Record<string, string> = {
  disabled: '话题检索未启用（config.json 里 topicSearch.enabled 为 false）。',
  remote_not_loopback: '拒绝：该端点只接受本机回环调用。',
  missing_header: '本机鉴权失败：请求缺少签名头。',
  sig_mismatch: '本机鉴权失败：签名不匹配（~/.botmux/.dashboard-secret 与运行中的宿主不一致？）。',
  replay: '本机鉴权失败：重放被拒绝。',
  ts_window: '本机鉴权失败：请求时间戳超出窗口，检查本机时钟。',
  forbidden: '拒绝：请求的群范围超出当前调用者的授权。',
  invalid_query: '查询不合法：需要一个非空、≤200 字符的查询串。',
  invalid_limit: '参数不合法：--limit 需在 1..50。',
  invalid_filter: '参数不合法：--chat/--from/--to 格式不对。',
  invalid_cursor: '分页游标无效或已过期，请重新查询。',
  search_unavailable: '检索服务内部错误（详见宿主日志）。',
  body_too_large: '请求体过大。',
};

async function commandSearch(rest: string[]): Promise<number> {
  const unknown = unknownArgs(rest, { valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS });
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}`);
    return 2;
  }
  const query = firstPositional(rest, VALUE_FLAGS);
  if (!query) {
    console.error('用法：botmux topic search <查询串> [--mode auto|keyword|hybrid] [--limit N] [--chat <chatId>]… [--from ISO] [--to ISO] [--cursor C] [--json]');
    return 1;
  }
  const mode = argValue(rest, '--mode');
  if (mode !== undefined && !['auto', 'keyword', 'hybrid'].includes(mode)) {
    console.error('--mode 只能是 auto / keyword / hybrid');
    return 1;
  }
  const limitRaw = argValue(rest, '--limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1 || limit > 50)) {
    console.error('--limit 需在 1..50');
    return 1;
  }

  const portOverride = argValue(rest, '--port');
  const endpoint = readEndpointInfo();
  const port = portOverride !== undefined ? Number(portOverride) : endpoint?.port;
  if (!port || !Number.isFinite(port)) {
    console.error('找不到话题检索端点：宿主（dashboard）未运行，或尚未启用 topicSearch。');
    return 1;
  }

  const chatIds = argValues(rest, '--chat');
  const body = {
    query,
    ...(mode ? { mode } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(chatIds.length > 0 ? { filters: { chatIds } } : {}),
    ...(argValue(rest, '--from') ? { filters: { ...(chatIds.length > 0 ? { chatIds } : {}), sourceFrom: argValue(rest, '--from') } } : {}),
    ...(argValue(rest, '--to')
      ? {
          filters: {
            ...(chatIds.length > 0 ? { chatIds } : {}),
            ...(argValue(rest, '--from') ? { sourceFrom: argValue(rest, '--from') } : {}),
            sourceTo: argValue(rest, '--to'),
          },
        }
      : {}),
    ...(argValue(rest, '--cursor') ? { cursor: argValue(rest, '--cursor') } : {}),
  };

  let response: Response;
  try {
    response = await fetchDaemonIpc(port, TOPIC_SEARCH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    console.error('无法连接话题检索端点（端口可达性/loopback 代理问题）。');
    return 1;
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
    console.error(SEARCH_ERROR_TEXT[code] ?? `查询失败：${code}`);
    return response.status === 401 || response.status === 403 ? 2 : 1;
  }
  printJson(payload, argValue(rest, '--json') !== undefined || rest.includes('--json'));
  return 0;
}

function commandConfig(rest: string[]): number {
  const action = rest[0] ?? 'show';
  if (action === 'show') {
    const global = readGlobalConfig();
    const resolved = resolveTopicSearchConfig(global.topicSearch);
    printJson(
      {
        configFile: '~/.botmux/config.json',
        section: global.topicSearch ?? null,
        resolved: resolved.config,
        blockedReason: resolved.config.enabled
          ? resolved.config.allowedChatIds.length === 0
            ? 'no_allowed_chats'
            : resolved.config.llmModelRef
              ? null
              : 'no_llm_model_ref'
          : 'disabled',
        issues: resolved.issues,
        credentialsNote:
          '凭证不在本配置文件里：摘要/向量端点由 BOTMUX_TOPIC_LLM_* / BOTMUX_TOPIC_EMBEDDING_* 环境变量提供。',
      },
      rest.includes('--json'),
    );
    return 0;
  }
  if (action === 'set') {
    const jsonArg = rest[1];
    if (!jsonArg) {
      console.error("用法：botmux topic config set '<json>'（例如 '{\"enabled\":true,\"allowedChatIds\":[\"oc_xxx\"],\"llmModelRef\":\"topic-enricher\"}'）");
      return 1;
    }
    let patch: unknown;
    try {
      patch = JSON.parse(jsonArg);
    } catch {
      console.error('配置不是合法 JSON。');
      return 1;
    }
    const current = readGlobalConfig().topicSearch ?? {};
    const merged = {
      ...current,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) && 'embedding' in patch
        ? { embedding: { ...(current.embedding ?? {}), ...((patch as TopicSearchGlobalConfig).embedding ?? {}) } }
        : {}),
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) && 'schedule' in patch
        ? { schedule: { ...(current.schedule ?? {}), ...((patch as TopicSearchGlobalConfig).schedule ?? {}) } }
        : {}),
    };
    const validation = validateTopicSearchConfig(merged);
    if (!validation.ok) {
      console.error('配置校验失败：');
      for (const issue of validation.issues) console.error(`  - ${issue.code} (${issue.field})`);
      return 1;
    }
    mergeGlobalConfig({ topicSearch: validation.value as unknown as TopicSearchGlobalConfig });
    printJson({ ok: true, topicSearch: validation.value }, rest.includes('--json'));
    return 0;
  }
  console.error(`未知子命令：topic config ${action}（可用：show / set）`);
  return 1;
}

function commandStatus(rest: string[]): number {
  const global = readGlobalConfig();
  const resolved = resolveTopicSearchConfig(global.topicSearch);
  const endpoint = readEndpointInfo();
  let storeInfo: Record<string, unknown> = { available: false };
  try {
    const store = openTopicStore({ path: topicStorePath() });
    const topics = store.listTopics({ limit: 5_000 });
    const summaries = topics.reduce((total, topic) => total + topic.summaries.length, 0);
    storeInfo = {
      available: true,
      storePath: store.path,
      topics: topics.length,
      summaries,
      pendingEmbeddings: store.pendingEmbeddingTasks(1_000).length,
      nextRunAt: store.getNextRunAt(),
      lastCheckedAt:
        topics
          .map(topic => topic.lastCheckedAt)
          .filter((value): value is string => typeof value === 'string')
          .sort()
          .at(-1) ?? null,
    };
    store.close();
  } catch (error) {
    storeInfo = { available: false, reason: (error as Error).name };
  }
  printJson(
    {
      enabled: resolved.config.enabled,
      schedule: resolved.config.schedule,
      allowedChatIds: resolved.config.allowedChatIds.length,
      embedding: resolved.config.embedding,
      issues: resolved.issues,
      endpoint: endpoint ? { port: endpoint.port } : null,
      store: storeInfo,
    },
    rest.includes('--json'),
  );
  return 0;
}

export async function runTopicCommand(subcommand: string, rest: string[]): Promise<number> {
  switch (subcommand) {
    case 'search':
      return commandSearch(rest);
    case 'config':
      return commandConfig(rest);
    case 'status':
      return commandStatus(rest);
    case '':
    case 'help':
    case '--help':
      console.log(
        [
          '用法：botmux topic <子命令>',
          '',
          '  search <查询串>   在本机已索引的话题摘要里检索（--mode/--limit/--chat/--from/--to/--cursor/--json）',
          '  status            查看启用状态、进度与端点',
          '  config show       查看配置（凭证只来自环境变量，不在此处）',
          "  config set '<json>'  更新配置节（写前校验，非法值拒绝）",
        ].join('\n'),
      );
      return 0;
    default:
      console.error(`未知子命令：topic ${subcommand}（可用：search / status / config）`);
      return 1;
  }
}
