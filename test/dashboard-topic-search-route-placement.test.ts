import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 源码结构护栏(K2)：话题检索路由必须注册在 Dashboard 认证 gate **之后**。
// 这条不变量没有行为 seam：验证它只能起真实 dashboard server 用匿名请求打（e2e，需要
// bots.json / daemon）。一旦有人把这行 if 挪到 gate 前面，匿名请求就能读到全量话题摘要，
// 静默且没有别的测试会红。因此这里只断言「顺序」与「没进白名单」，不断言实现文本。
describe('话题检索路由的注册位置', () => {
  it('路由注册出现在认证 gate 之后（否则匿名可读摘要）', () => {
    const source = readFileSync(join(ROOT, 'src', 'dashboard.ts'), 'utf8');
    const gateAt = source.indexOf('resolveDashboardRequestGate({');
    const denyAt = source.indexOf("decision.kind === 'deny401'");
    const routeAt = source.indexOf('url.pathname === TOPIC_SEARCH_ROUTE');
    expect(gateAt).toBeGreaterThan(0);
    expect(denyAt).toBeGreaterThan(gateAt);
    expect(routeAt).toBeGreaterThan(denyAt);
  });

  it('路由没有出现在公开读白名单与 workbench H5 能力表里', () => {
    const auth = readFileSync(join(ROOT, 'src', 'dashboard', 'auth.ts'), 'utf8');
    expect(auth.includes("'/api/topic-search'")).toBe(false);
  });
});
