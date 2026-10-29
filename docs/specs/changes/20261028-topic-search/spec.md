# Spec：话题聚合检索增强（一期）

- 状态：Draft；所有新增类型、路径、接口均为拟议契约。
- 日期：2026-10-29；源码核查基线：`fc5b44746`。
- Intent：[intent.md](./intent.md)。
- MUST 表示必须满足；SHOULD 表示建议。

## 1. 当前架构与证据

| 当前能力 | 源码位置 | 已核查结论 |
|---|---|---|
| Session 数据 | `src/types.ts`：`Session` | 保存身份、位置、标题、时间、近期输入等；无通用自动摘要字段。 |
| 运行态 | `src/core/types.ts`：`DaemonSession` | 管理 worker、路由与运行状态，不是话题知识库。 |
| 话题聚合 | `src/dashboard/web/sessions.ts` | `SessionTopicGroup`、`sessionTopicKey`、`groupSessionsByTopic` 从 session 行计算话题视图。 |
| 搜索 | 同上及 `sessions-page.tsx` | `sessionSearchText` 序列化行数据，页面使用 `includes(q)`，之后按话题展示。 |
| 存储 | `src/services/session-store.ts`、`sqlite-compat.ts` | 已有 SQLite 及旧 JSON 迁移/兼容机制；新增功能不重定义 session 存储权威。 |
| 手动总结 | `src/im/lark/summary-command.ts`、`services/summary-range-store.ts` | 显式 `/summary` 读取历史；不是自动话题摘要索引。 |
| 模型命名 | `services/session-group-title.ts` | 通过 bot CLI 单次生成标题，不是通用后台摘要执行器。 |
| 配置与页面 | `global-config.ts`、`dashboard.ts`、`dashboard/web/sessions-page.tsx` | 承载模型配置、查询 API 与话题聚合页面接入。 |

当前聚合结构（字段按源码）：

```ts
interface SessionTopicGroup<T> {
  key: string;
  kind: 'thread' | 'chat' | 'session';
  chatId: string;
  rootMessageId?: string;
  title: string;
  rows: T[];
  botCount: number;
  activeCount: number;
  closedCount: number;
  inferredBotInputCount: number;
  latestActivityAt: number;
  multiBot: boolean;
  inferredBotTriggered: boolean;
}
```

这是视图，不应描述为已存在独立持久化 Topic 主表。

## 2. 目标架构和边界

```text
现有聊天链路：飞书 → Bot Daemon → Session/Worker → CLI → 飞书（保持不变）

可配置后台定时器
  → 已知授权话题枚举 → 分页增量读取飞书历史
  → 旧摘要 + 新消息 → 无工具 LLM → 校验变更 → 话题知识存储
                                                 → 可选 embedding

Dashboard 话题聚合页面
  → Dashboard 认证 → POST /api/topic-search → SearchService
  → 关键词/可选向量召回 → 融合排序 → 话题结果与命中摘要
```

- 不在消息主链路增加模型调用或 dirty 标记。
- 一个部署只有一个逻辑调度所有者。建议由现有中心宿主承载后台模块；复用其启动/退出生命周期，不强制新增进程。
- 内部保留 TopicSource、Enricher、Embedder、TopicStore、SearchService 边界；不要求插件化或另起微服务。
- 话题业务统一实现在 `src/topic/`，包括身份、存储、摘要、调度、模型适配和检索。`Topic` 与 `TopicSummary` 仍定义在 `src/types.ts`；浏览器只复用该模块内无运行时依赖的 `identity.ts`。
- SQLite 兼容层是引擎适配，不是话题业务复用：仅 `src/topic/store.ts` 依赖现有 `services/sqlite-compat.ts`，其余模块通过存储接口访问。HTTP 与页面适配留在 dashboard 入口层。
- 首版直接调用独立模型连接，不使用聊天 session 或 shell 执行摘要。

## 3. 数据契约

### 3.1 身份与持久化

- 新增核心类型统一命名为 `Topic`，定义在 `src/types.ts`，与现有 `Session` 并列。`TopicSummary` 作为其摘要条目类型；不另设另一套话题知识实体。
- `Topic` 是持久化话题实体；`Session` 是执行会话实体；`SessionTopicGroup` 仍是展示聚合结构，不能将三者混为一谈。

- 首版只处理 `kind=thread`；topicKey MUST 复用现有 `sessionTopicKey` 的编码规则，不能临时拼接另一种格式。
- `chatId + rootMessageId` 是路由话题身份；`larkThreadId/omt_*` 是原生跳转标识，两者不可互换。
- sessionId 与 topicKey 是多对一关系；relay 只改变 session 当前归属，不把源话题知识搬到目标话题。
- fork 产生新话题时 Topic 记录独立；不得把源话题摘要伪装为新话题已经发生的消息。
- 建议在独立 SQLite 存储中保存知识和任务状态，复用兼容层。不得把可重建的知识强耦合到 Session 核心类型，也不依赖浏览器页面维持数据。
- 已发现话题在 sessions 关闭后仍保留目录，按保留/授权策略处理；删除 session 不自动删除话题。重启不得遗忘待处理任务。

```ts
interface Topic {
  schemaVersion: 1;
  topicKey: string;
  chatId: string;
  rootMessageId: string;
  nativeThreadId?: string;
  title: string;                    // 目录快照，不反向改 session 标题
  accessPolicyRef: string;          // 权威授权关联，不由模型填写
  revision: number;
  summaries: TopicSummary[];
  summarizedThroughCursor?: string; // 上次成功摘要的源消息边界，不是分页临时 token
  coverageStartAt?: string;         // ISO-8601 UTC
  sourceThroughAt?: string;         // 输入已成功处理到的时间
  lastCheckedAt?: string;           // 最近成功检查历史的时间
  updatedAt: string;
}

interface TopicSummary {
  id: string;                       // 服务端分配，更新时稳定
  text: string;
  keywords: string[];
  sourceMessageIds: string[];
  updatedAt: string;
  generatorKey: string;             // 模型/提示词版本，不包含凭证
  embedding?: {
    modelKey: string;               // provider/model/revision/dimensions 标识
    contentHash: string;
    vector: number[];
  };
}
```

- API 的话题级 keywords 是摘要关键词的规范化去重并集，不创建两份独立可写真相。
- 数组是逻辑结构，物理上可拆 Topic/Summary/Embedding 表；无需全量重写数组。
- 消息引用 MUST 属于该话题且在本次授权输入/旧摘要来源集合内；模型不能伪造其他话题引用。
- 处理状态另存 job 记录：topicKey、输入版本/范围、状态、重试次数、下次尝试时间、脱敏错误码、租约。无需放入公开检索结果。
- 默认不长期保存完整原消息；处理任务可有受限临时输入，成功/过期后清理。需长期原文搜索时另行评审。

### 3.2 数据范围

首版只把同一明确授权策略下的“话题公开消息”合并摘要，不读取 session 内部输入。若源消息可见性不一致，必须拆分权限域或拒绝混合，不能先生成包含秘密的总摘要再做过滤。

## 4. 配置契约

全局配置新增可选节；新安装与升级缺省均关闭：

```json
{
  "topicSearch": {
    "enabled": false,
    "allowedChatIds": [],
    "llmModelRef": "topic-enricher",
    "embedding": { "enabled": false, "modelRef": null },
    "schedule": {
      "kind": "cron",
      "expression": "0 2 * * *",
      "timeZone": "Asia/Shanghai"
    },
    "initialLookbackDays": 14,
    "maxConcurrentTopics": 1,
    "maxTopicsPerRun": 20
  }
}
```

每日 02:00 仅为配置示例，不是固定执行时间；实际周期、时区和历史范围由配置决定。每日检查不等于每天重新总结全部话题。

- interval 与 cron/fixed-time 互斥；固定时间 MUST 配 IANA 时区，DST 重复时段按槽位 ID 去重。
- 管理员可选周期/固定时间；首版复用全局配置读写和校验入口，不新增配置 CLI。
- ModelProfile 包含 provider adapter、endpoint、model、credentialRef、超时、重试/速率/输入预算；embedding 还包含维度及模型版本。
- 摘要与关键词共用一次结构化 LLM 调用；不继承任一聊天 bot 的模型/env。
- 凭证只在宿主受保护的存储中解析，不能回显、传给一般 agent 或写入检索库。
- 开启模型外发前必须明确授权数据范围与 provider；配置接口仅管理员可写，并防止任意调用者注入 endpoint。
- 未启用 embedding 时不初始化相关客户端、不要求密钥、不发请求。
- 模型连接必须声明支持的协议与能力；不得默认假设任意聊天模型支持 embedding。

## 5. 定时更新行为

### 5.1 成功处理游标与成本原则

- `summarizedThroughCursor` 表示上次成功处理到的源消息边界，由源适配器编码稳定的消息标识及必要顺序信息。消息 ID 不透明，不得用字符串大小推断先后；此字段也不是可能过期的 API 分页 token。
- 不以 `hasNewMessages` 布尔值作为处理权威。定时读取边界之后的消息，判断是否存在增量；session 活动时间只提供优先级提示。
- `lastCheckedAt` 只表示历史检查状态，不能替代成功摘要游标。读取成功但摘要失败时，成功摘要游标必须保留原位置。
- 无新消息且无源修正等维护任务时，不调用 LLM、不创建 embedding 任务。不得额外调用模型判断“是否需要总结”。
- 有新消息时，仅处理有界新增消息及相关旧摘要，不每天重发完整历史；一次调用同时生成摘要变更和关键词。
- embedding 输入为摘要正文时，仅新增或正文变化触发向量生成，关键词变化但正文不变无需重算。无增量时仍可独立重试此前失败的向量任务，不重新生成摘要。
- 定时检查仍有接口和分页成本，零模型调用不等于零扫描成本。首版不强制活跃分层或群级扫描。

### 5.2 执行步骤

1. 到达槽位后获取部署级租约；同一槽位不重复执行，跨进程争抢只能有一个胜出。
2. 从持久目录及现有 sessions 发现授权话题，合并后分页扫描。未启动/无真实话题的记录跳过。
3. 最近 session 活动只用于优先级，不能据此永久跳过旧话题；每轮使用公平游标，避免历史话题饥饿。
4. 按配置首轮历史范围或上次已提交边界读取消息。源适配器必须验证分页完整性、去重和顺序；不能仅凭时间戳丢弃同毫秒消息。
5. 没有增量：仅更新检查状态，不为本次扫描创建 LLM/embedding 任务。
6. 有增量：固定本次输入结束边界，提供相关旧摘要及有界新增消息，模型输出结构化 add/update/noop。执行期间新到消息不包含在本次提交边界内。
7. 校验后通过 revision CAS 原子提交摘要、关键词及 `summarizedThroughCursor`。noop 也代表本批消息处理成功，应提交游标；失败则游标不变。冲突重新读取，不覆盖更新结果。
8. 对变化摘要异步生成 embedding；LLM 已成功时 embedding 失败不回滚摘要，也不重复调用 LLM。

### 5.3 模型输出与更新规则

```ts
type SummaryMutation =
  | { op: 'add'; text: string; keywords: string[]; sourceMessageIds: string[] }
  | { op: 'update'; id: string; text: string; keywords: string[]; sourceMessageIds: string[] }
  | { op: 'noop' };
```

- 新事件 add，同一事件补充 update，无实质信息 noop。MUST 校验未知 ID、重复冲突操作、空正文、长度上限和来源。
- 模型不能修改 topicKey、权限、游标、版本或 embedding。
- 不提供用户反馈、更正按钮、人工摘要编辑或模型任意 delete。
- “由 A 改为 B”若来自新消息，可在同一条摘要保留转变；无需首版复杂事件版本 UI，也不能改写成始终只有 B。
- 源消息里的指令视为材料，不授予执行权限；模型调用不带 shell/文件写入工具。
- 摘要数量增长时只选择相关旧摘要和有限窗口；未处理部分留给后续任务，不默默截断后推进完整游标。

### 5.4 恢复、新鲜度与删除

- 失败/不完整分页/无权限不得推进处理游标；指数退避且有上限，单话题失败不阻断其它话题。
- 超时和重启后租约可回收；调度错过多个槽位时合并为一次增量运行，不补发成百上千任务。
- 停用后不再创建任务；运行中任务在提交/外发边界检查停用及授权状态。
- 新消息直到下次成功运行才进入摘要检索，响应展示覆盖范围和更新时间。
- 变更摘要时旧 embedding 立即不可用于新正文；结果按 contentHash 校验，迟到向量丢弃。
- 权限撤销后立即禁止读取；在确认消息删除/修改时失效或重建关联摘要和向量。定时拉取有界重叠窗口发现近期变更；不能宣称实时发现全历史删除，历史重核周期需显式配置。若要求严格全历史删除 SLA，需扩展源适配器，不能仅靠增量游标承诺。
- 已配置保留期限到期时清理摘要和向量；关闭功能与清空数据是不同管理动作。

### 5.5 增量示例

昨天成功处理到 M100，今天读取到 M101–M110：模型只接收这批新消息和相关旧摘要。保存成功后，游标推进到本批结束边界 M110。执行期间到达 M111，则下轮处理。若读取不完整、模型输出无效或提交失败，游标仍为 M100。重试不能重复添加已提交条目。M100 等仅为示例顺序标签，不表示真实消息 ID 可以递增比较。

## 6. 检索与统一接口

### 6.1 召回

- 首版搜索：话题标题、summary.text、summary.keywords；不提供原消息全文检索。
- 关键词规范化、分词/多词匹配；精确关键词/实体提高权重，中文必须有测试。
- embedding 输入以单条摘要为单位；查询向量和候选向量必须 modelKey/维度一致。
- keyword 与向量通道在授权候选范围内召回；不得先全库取 Top-K 再简单过滤而导致越权或合法结果被挤掉。
- 混合模式建议 RRF 名次融合，再按 topicKey 去重。每个话题只返回一条，并携带命中的摘要片段。
- 首版无需专用搜索引擎。可以对有界授权集合做关键词扫描/精确向量计算；实际规模超标后增加物理索引，但保持接口。
- 所有查询有输入长度、候选规模、耗时和返回数量限制。达到预算返回 partial，不静默宣称完整。

### 6.2 Dashboard 查询接口（拟议）

一期查询接口供现有 Dashboard 话题聚合页面使用：`POST /api/topic-search`。复用 Dashboard 现有端口、登录认证和访问策略，路由置于现有认证 gate 后，不加入公开读白名单。保留已有 Dashboard 部署访问方式。

- 查询主体是 Dashboard 用户，不使用聊天 Bot 的话题参与关系进行筛选。
- 请求 filters 缩小页面已有可见范围；沿用 Dashboard 的会话归属与访问策略。
- 后台消息采集通过有访问能力的 daemon 完成，继续使用已有内部通信认证。
- 一期不提供 Agent CLI、Skill、MCP 或对外服务接口。

```json
{
  "query": "之前讨论跨 bot owner 的话题",
  "filters": { "chatIds": [], "sourceFrom": null, "sourceTo": null },
  "mode": "auto",
  "limit": 5,
  "cursor": null
}
```

- `mode`：keyword / hybrid / auto；limit 范围 1–50。
- filters 的时间限制是来源消息时间，不是摘要生成时间；无日期时不自动排除历史。
- chatIds 只能缩小调用者已有范围，不能请求提权。日期使用带时区的 ISO-8601。
- cursor 为不透明、短期有效标识，绑定调用者、过滤条件和查询/索引版本；版本不兼容要求重新查询。

```json
{
  "items": [{
    "topicKey": "thread:...",
    "title": "话题标题",
    "url": "经过校验的话题入口",
    "matches": [{ "summaryId": "s1", "text": "命中摘要", "sourceMessageIds": ["om_..."] }],
    "updatedAt": "2026-10-29T01:00:00Z",
    "sourceThroughAt": "2026-10-29T00:55:00Z"
  }],
  "effectiveMode": "keyword",
  "degradedReasons": ["embedding_disabled"],
  "coverage": { "state": "partial", "unindexedKnownTopics": 2 },
  "nextCursor": null
}
```

- 实际响应不得返回凭证、原始向量、内部 prompt 或未授权源 ID；coverage 计数也只限调用者可见范围。
- 覆盖范围只针对当前部署已知目录，不声称覆盖整个飞书租户。
- hybrid/auto 在向量不可用时返回关键词结果并标注降级；keyword 不请求 embedding。
- 错误：400 输入错误；401 未认证；403 无授权/功能禁用；429 超预算；503 查询服务不可用。embedding provider 故障有关键词结果时不整体返回 503。
- 页面展示命中摘要、来源链接、更新时间、partial 和降级状态。
- 空查询或功能关闭时使用原有列表。启用内容检索时由服务返回排序后的 topicKey，页面按该顺序呈现话题，沿用原有 session 分组和展开。
- 内容检索结果不再叠加旧的 sessionSearchText 包含过滤；现有状态和 Bot 筛选保留，按话题中的关联 session 判断。
- 关闭 session 后仍可命中持久化 Topic；没有现存 session 行时展示话题标题、摘要与话题入口。
- 模型调用范围按已配置的数据源与 provider 执行。

## 7. 代码修改边界与兼容性

| 模块 | 变更 | 不变部分 |
|---|---|---|
| `src/types.ts` 与话题共享逻辑 | 新增与 `Session` 并列的 `Topic`、`TopicSummary`；提取现有 topicKey/grouping 纯逻辑 | 现有 Session 字段与语义、key 编码、Dashboard 聚合表现 |
| `global-config.ts` 及配置校验 | 新增可选配置和模型引用 | 旧配置缺省行为、各 bot 聊天模型 |
| 新 `src/topic/`（拟议） | Topic 持久化、源读取、任务更新、模型适配、查询 | Session lifecycle/storage authority |
| 宿主启动/退出与 API 路由 | 一个后台调度实例、只读接口、鉴权 | 原消息入站/回复路径；不加 dirty hook |
| `im/lark/client.ts` 等历史读取 | 复用或补有界分页能力，需回归测试 | `/summary` 原行为与 owner 边界 |
| CLI、Skill、MCP | 一期不新增入口 | 现有行为 |
| Dashboard 话题聚合页面 | 接入检索 API、排序和摘要展示 | 原有分组、展开、筛选与入口 |
| CLI/Backend/Worker | 原则上不修改 | PTY、Tmux、RPC、sandbox 与 20+ CLI 路径 |

实现不得使用 `__dirname` 拼出编译态可写路径；数据存到配置解析出的真实目录。测试子进程使用 `test/helpers/ts-runner.ts`。不得在 worktree install 或扩大 trustedDependencies。

## 8. 验收与 Intent 追踪

| 验收 ID | 关联目标 | 用例与通过条件 |
|---|---|---|
| A-01 | I-01/I-02 | 同一 thread 三个 sessions → 一个 topicKey/结果；关闭 session 后目录保留；不同群同样标题不合并。 |
| A-02 | I-03/I-04 | 每日槽位只更新有新消息的话题；无增量且无待重试任务时零模型调用；两个调度器争抢同一槽位只有一个提交。 |
| A-03 | I-04 | add/update/noop 均验证；未知 summary ID/伪造来源拒绝；CAS 冲突不丢数据。 |
| A-04 | I-03 | API 分页失败、模型超时、进程崩溃后恢复；游标不越过失败范围，成功结果不重复；处理 M101–M110 时到达 M111 不被跳过；noop 正常推进边界。 |
| A-05 | I-06 | embedding 关闭无密钥可启动；失败降级且只重试向量；仅重算新增/正文变化的摘要，正文不变不重算；换模型不混用维度/空间。 |
| A-06 | I-05 | 沿用 Dashboard 登录与访问范围；未登录和只读访客按现有敏感历史策略拒绝；filters 只缩小可见范围。 |
| A-07 | I-07 | 近期/旧话题、中文同义表达、精确错误码测试；未覆盖显示 partial，而非完整空结果。 |
| A-08 | I-08 | 功能关闭时无额外模型请求/后台扫描；模型故障不影响发消息、会话恢复和原 Dashboard。 |
| A-09 | I-01/I-02 | relay/fork 不混淆来源；chat-scope/无根 ID 会话明确跳过，不错误归为 thread。 |
| A-10 | I-03/I-05 | 停用、撤权、已知消息删除后不继续泄露；晚到模型/向量结果不能重新写回已失效内容。 |

建议质量目标（不是当前测量结果）：
- 准备至少 20 条真实查询及人工确认的目标话题；固定摘要快照与模型版本，比较现有过滤、关键词、混合三组。
- 建议 Top-3 命中率至少 80%，并报告关键词与混合各自结果，不要求混合必然提升。
- 在固定、记录硬件的 1,000 话题/10,000 摘要测试集上，建议关键词 P95 ≤ 1 秒；混合近期查询超出建议 3 秒预算则返回可用结果并说明降级。均从 HTTP 入站到响应计，不含页面渲染耗时。
- 历史允许更大预算/分页，但不能无限等待或隐藏覆盖缺口。实际预算通过配置和测量确定。
- 模型成本、摘要延迟、跳过/失败话题数、待生成向量数可观测；日志不得包含原文或凭证。

实现验证矩阵：macOS/Linux；Node/Bun/单文件编译态；至少两种 CLI 的正常聊天回归；thread/chat scope；关闭/恢复/relay/fork；sandbox on/off；模型开关组合。本文未执行上述功能测试。

## 9. 启停与回滚

- 默认禁用；启用配置必须明确群范围、provider 和历史范围。
- 新存储独立创建；不批量改写 Session。停用即可停止后台更新和新模型调用，不影响旧业务。
- 回滚保留或显式清理派生数据；不得删除原消息、session 或用户 `summary.md`。

已确认不包含：用户反馈更新、专职摘要 bot、消息事件即时触发、全局 session 管理、独立向量数据库强依赖。

## 10. 新基线接入约束

- 历史分页复用 `im/lark/client.ts` 的统一遍历实现及 thread 上下文；补充话题增量读取的完整性、停止边界、取消和预算契约。最近 N 条消息不等于全部增量，截断不得推进到未覆盖范围之后。
- 复用 `core/native-topic-id.ts` 的原生 ID 校验；deferred topic 尚未绑定真实路由锚点时不创建 Topic，绑定后再发现。`core/topic-spec.ts` 是指令头会话规格，不是持久化 Topic。
- `services/durable-coordination.ts` 与 `sqlite-durable-coordination.ts` 已有持久协调原语；实现前评估其适用性，不复用 session 专属租约来充当部署级摘要租约。Topic 内容事务保持独立。

页面验收补充：内容命中而 session 字符串不命中的话题仍能显示；多个 session 只显示一个话题；排序、筛选、展开、入口正常；功能关闭恢复原搜索；请求失败显示错误与重试入口。
