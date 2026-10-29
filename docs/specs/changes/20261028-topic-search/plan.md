# Plan：话题聚合检索增强（一期）

- 基线：`fc5b44746`，2026-10-29。
- 需求：[intent.md](./intent.md)；契约：[spec.md](./spec.md)。
- 以下路径和任务为计划交付项。

## 1. 架构与修改边界

```text
Dashboard 话题聚合页面
  → 现有 Dashboard 认证
  → POST /api/topic-search
  → src/topic/search.ts → Topic 存储

Dashboard 后台 runtime
  → 定时扫描 → daemon 读取话题历史
  → LLM 更新摘要与关键词 → 提交游标
  → 可选 embedding
```

复用 Dashboard 进程和端口。话题业务集中在 `src/topic/`；页面与 HTTP 适配放在 `src/dashboard/`。

```text
src/types.ts                        Topic、TopicSummary，与 Session 并列
src/topic/
  identity.ts                       话题键与浏览器可用的纯逻辑
  config.ts                         配置解析与校验
  store.ts                          存储、事务、迁移、任务状态
  source.ts                         历史增量读取契约与归一化
  model-client.ts                   摘要与关键词模型适配
  embedding-client.ts               可选向量模型适配
  summary-updater.ts                add/update/noop 更新
  scheduler.ts                      定时槽位、租约、公平扫描
  keyword.ts                        关键词召回
  vector.ts                         向量校验与相似度
  search.ts                         融合、排序、话题去重
  runtime.ts                        启动、停止、资源释放
  index.ts                          宿主公共导出
src/dashboard/topic-search-api.ts    页面查询 API 适配
src/dashboard/web/sessions.ts        共享身份接入及分组兼容
src/dashboard/web/sessions-page.tsx  搜索结果与摘要展示
```

外围接线：`src/global-config.ts`、`src/dashboard.ts`；历史读取不足时扩展 `src/im/lark/client.ts` 和 daemon 内部只读路由。

一期不新增 CLI、Skill、MCP、Agent 调用授权、端口或进程。不改 Session 生命周期、聊天模型和用户定时提醒语义。

## 2. 接入约定

### 2.1 页面与接口

- `POST /api/topic-search` 挂到 Dashboard 现有认证 gate 后，使用现有用户访问范围，不加入公开读白名单。
- 页面查询与 Bot 是否参与目标话题无关。
- 空查询或功能关闭使用原列表；启用内容检索时采用服务返回的话题排序。
- 原有 Bot/状态筛选、话题分组、session 展开与打开入口继续保留。
- 内容检索不叠加旧字符串包含过滤。
- 无现存 session 行的历史 Topic 展示标题、摘要及话题入口。
- 页面显示加载、失败重试、空结果、partial、降级及更新时间。

### 2.2 宿主与历史读取

- Dashboard runtime 负责一个部署的调度与查询服务。网页关闭不影响后台运行；进程停止后暂停更新，恢复后执行一次增量补跑。
- 从本机 daemon session 数据与持久 Topic 目录发现话题。
- 由有访问能力的 daemon 读取源消息，复用内部认证链路。
- 复用现有统一分页实现、`listThreadMessagesWithContext` 和 `listMessagesByThreadId`；补充增量停止边界、完整性、预算与取消契约。
- 部分读取只推进已完整处理的范围。

### 2.3 模块依赖

- 公共类型定义在 `src/types.ts`；`identity.ts` 保持浏览器可用。
- `store.ts` 复用 `services/sqlite-compat.ts` 的 Node/Bun 引擎 API。
- 评估 durable-coordination 的通用协调原语；Topic 内容与任务在自身存储中原子提交，部署摘要租约独立于 session 租约。
- runtime 注入配置、源读取和存储；业务模块不依赖 Dashboard 页面。

## 3. 实施任务

### P0：基线与夹具

核对 Dashboard 认证、话题页面筛选/排序、daemon 历史读取和宿主启停接线。建立跨 session 同话题、历史话题、同毫秒消息、重复分页和延迟绑定夹具。

完成条件：列明接入函数及现有测试；确认页面可见范围、历史数据源与分页边界。

### P1：Topic 与身份

修改 `src/types.ts`、`src/dashboard/web/sessions.ts`，新增 `src/topic/identity.ts`。

- 新增 Topic、TopicSummary，复用原 topicKey 编码与分组语义。
- thread 创建 Topic；chat/DM/虚拟锚点跳过。
- deferred topic 绑定真实锚点后进入目录。
- 复用 native-topic-id 校验，分别处理路由根消息 ID 与原生话题 ID。

测试：`test/topic-identity.test.ts`；覆盖多 session、不同群、relay/fork 和延迟绑定。

### P2：存储与恢复

新增 `src/topic/store.ts`。

- 保存 topics、summaries、embeddings、jobs、schedule_state。
- 使用 schemaVersion 迁移、revision CAS、任务幂等键和租约。
- 摘要、关键词、来源、成功游标及向量任务同事务提交。
- 内容变化时失效旧向量；关闭 session 保留 Topic。

测试：`test/topic-store.test.ts`；覆盖回滚、冲突、重启、重试、失效与迁移。

### P3：配置与模型

修改全局配置及校验入口；新增 topic config/model-client/embedding-client。

- 配置启用开关、数据范围、时间/时区、历史范围、并发、预算与模型引用。
- 摘要与关键词一次结构化调用，独立于聊天模型。
- embedding 默认关闭；开启后校验模型、维度与 contentHash。
- 通过现有全局配置入口交付，不新增配置 CLI。

测试：`test/topic-search-config.test.ts`、`test/topic-model-client.test.ts`，使用假 provider。

### P4：定时增量更新

新增 source、summary-updater、scheduler、runtime，接入 Dashboard 生命周期。

- 公平扫描已知话题，读取成功游标之后的新增消息。
- 无增量跳过模型；有增量结合相关旧摘要执行 add/update/noop。
- 固定本批上界；成功推进游标，失败保留原位置。
- embedding 独立重试；支持停止、恢复和错过槽位合并。
- 近期源变更用重叠窗口检查，历史重核使用独立预算。

测试：`test/topic-source.test.ts`、`test/topic-summary-updater.test.ts`、`test/topic-scheduler.test.ts`。

### P5：检索服务

新增 search、keyword、vector。

- 在 Dashboard 用户可见范围内召回标题、摘要与关键词。
- embedding 可用时向量召回，与关键词通过 RRF 融合。
- 按 topicKey 去重，返回排序、摘要来源、覆盖范围与分页游标。
- keyword 不请求向量；向量失败降级为关键词结果。

测试：`test/topic-search.test.ts`；覆盖中文、多词、精确错误码、历史话题、去重、降级与预算。

### P6：Dashboard API 与话题页面

新增 `src/dashboard/topic-search-api.ts`；修改 `src/dashboard.ts` 和话题聚合页面。

- 注册 `POST /api/topic-search`，沿用 Dashboard 认证和敏感历史访问策略。
- 接入查询、分页、排序与命中摘要展示。
- 保留原筛选、展开和导航；清空查询恢复原列表。
- 展示历史 Topic、加载与错误状态；处理快速连续查询的过期响应。

测试：`test/topic-search-api.test.ts` 及页面测试。验证未登录/只读访客、可见范围、内容命中、过滤、分页、关闭功能回退与请求乱序。提供页面截图。

### P7：集成与交付

验证完整流程：话题发现 → 定时摘要 → 关键词/向量查询 → 聚合页面展示与跳转。

执行 spec A-01 至 A-10；记录命中率、延迟、调用量与扫描成本。补管理员配置、积压/故障查看、停用和数据清理说明。

## 4. 验证

工具链：以 `package.json` 的 `bun@1.4.3` 为准。实现后执行：

```sh
bun run build
bun run test -- test/topic-identity.test.ts test/topic-store.test.ts
bun run test -- test/topic-search-config.test.ts test/topic-model-client.test.ts
bun run test -- test/topic-source.test.ts test/topic-summary-updater.test.ts test/topic-scheduler.test.ts
bun run test -- test/topic-search.test.ts test/topic-search-api.test.ts
bun run test -- test/session-store.test.ts test/session-store-sqlite.test.ts test/summary-command-window.test.ts
bun run test
```

- 页面验证：原聚合行为、摘要结果、筛选、分页、展开、跳转、关闭回退和失败重试。
- 环境矩阵：macOS/Linux、Node/Bun/单文件编译态。
- 回归：两种 CLI 正常聊天、thread/chat、关闭恢复、relay/fork、sandbox 开关。
- 成本：无新增消息时摘要调用为零；向量重试单独计数。
- 质量：固定查询集和数据规模，报告 Top-3、P95 与模型用量。
- 子进程测试使用 `test/helpers/ts-runner.ts`。

当前文档修订仅完成源码核查与文档检查；功能测试随实现执行。

## 5. 部署与回滚

默认关闭部署；先用假 provider 验证，再配置小范围话题。首次回填按时间范围与预算推进。人工验证按仓库部署流程执行。停用关闭后台更新和内容检索，页面回到原搜索；Topic 数据保留，清理作为独立操作。

## 6. 交付追踪

| 任务 | 验收 |
|---|---|
| P1/P2 | A-01、A-03、A-04、A-09 |
| P3/P4 | A-02、A-03、A-04、A-08、A-10 |
| P5 | A-05、A-07 |
| P6 | A-01、A-06、A-07、A-08 |
| P7 | 全部验收与页面截图 |
