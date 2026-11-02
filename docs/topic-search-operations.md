# 话题内容检索：运行与离线验收

当前状态：独立实现已进入 review，尚未完成整体验收。以下配置是参考，不表示已配置、部署或授权在线调用。

## 边界

- 后台宿主是 Dashboard，定时器不依赖打开网页。数据是 `${SESSION_DATA_DIR}/topic-search/topics.sqlite`，不修改 Session、来源消息或用户 `summary.md`。
- Topic 按群和话题根消息标识归属。多个执行会话只对应一个 Topic；会话关闭后保留历史话题。chat-scope/虚拟根不索引。
- 当前目录来自本部署已知的真实 thread 会话，**不是全租户话题发现器**。无 Session 的历史条目必须曾被本部署发现并持久化。
- `allowedChatIds` 是新来源读取/摘要更新范围，不是 Dashboard 历史可见范围。管理员可检索仍保留的历史摘要；移出更新范围不自动删除摘要或禁止其 embedding 重试。
- HTTP 检索和状态接口沿用现有 Dashboard 登录及敏感历史管理权限；匿名、公开只读、Workbench-only 用户不能访问。daemon 来源接口只接受可信宿主且额外检查更新范围。

## 配置

全局配置默认位于 `~/.botmux/config.json`；`BOTMUX_GLOBAL_CONFIG_FILE` 可覆盖为绝对路径。`topicSearch` 缺省关闭。管理员设置写入口支持单独提交完整 `topicSearch` 对象，不能与其他配置节混写；部分字段省略时会采用默认值，**不是任意深层 patch**。

下面是关闭状态的样例。启用前须先由管理员确认模型、来源范围、预算以及在线验证授权。

```json
{
  "topicSearch": {
    "enabled": false,
    "allowedChatIds": ["oc_example"],
    "llmModelRef": "summary",
    "models": {
      "summary": {
        "adapter": "openai-chat",
        "endpoint": "https://provider.example.invalid/v1",
        "model": "replace-with-authorized-model",
        "credentialRef": "env:BOTMUX_TOPIC_SUMMARY_KEY",
        "timeoutMs": 30000,
        "retries": 1,
        "requestsPerMinute": 30,
        "maxInputChars": 24000,
        "maxOutputTokens": 2048
      }
    },
    "embedding": { "enabled": false, "modelRef": null },
    "schedule": { "kind": "cron", "expression": "0 2 * * *", "timeZone": "Asia/Shanghai" },
    "initialLookbackDays": 14,
    "maxConcurrentTopics": 1,
    "maxTopicsPerRun": 20,
    "maxStepsPerTopic": 100,
    "maxPagesPerRead": 50,
    "maxMessagesPerBatch": 100,
    "maxInputChars": 24000,
    "maxOldSummaries": 20,
    "maxAttempts": 3,
    "retryBaseMs": 30000,
    "jobTimeoutMs": 120000,
    "overlapHours": 24,
    "historicalRecheckDays": 30,
    "maxHistoricalChecksPerRun": 2,
    "retentionDays": null
  }
}
```

- 环境变量必须是独立的 `BOTMUX_TOPIC_*` 凭据，注入 Dashboard 宿主。配置中不能放明文 key、任意 headers、带密码/查询参数的 URL；不会继承 CLI 对话模型授权。不要把真实密钥写进文档、命令历史或日志。
- 当前仅支持明确的 OpenAI-compatible chat/embeddings HTTP 适配器，不启动 CLI/Agent、不调用工具。endpoint 是 API base，适配器追加 `/chat/completions` 或 `/embeddings`。
- embedding 可单独关闭；开启时用 `openai-embeddings` 配置独立模型引用、`version` 与 `dimensions`。更换端点/模型/版本/维度会切换模型标识，旧向量不参与新空间检索。
- interval 替代配置为 `{"kind":"interval","everyMs":86400000}`；不能与 cron 字段混用。间隔槽按时间基准划分，不等于“从启用时刻等待一天”；cron 使用显式 IANA 时区，错过多个槽合并为当前槽。
- 首轮 `initialLookbackDays` 固定为话题覆盖起点；修改配置不会偷偷重置已成功的游标或重做全部历史。

## 批次、失败、停用与恢复

一个部署持有数据库租约；同一槽只接纳一次批次。旧 owner/epoch/attempt 的迟到结果不能提交。摘要、成功游标、操作 receipt、任务结算是同一事务。

单次模型输入受消息数、字符数、相关旧摘要数限制。扫描可能跨页/跨步骤；提供者 page token 是临时进度，不是成功游标。失败可以丢弃临时 token 重新遍历，但不会跨过未成功处理的消息。同毫秒消息 ID 一并保留。

飞书 thread 接口当前按升序有界遍历；没有假设未验证的 since-time 能力。大历史仍可能需要扫描已处理的旧页，**不等于每天将全部旧消息重新发给模型**。超过本批步骤预算时，下个批次从已持久化进度继续，覆盖提示不能当作全历史完成。

- 无新增消息、无待重试/编辑修复时不调用摘要模型。
- 摘要失败只重试对应任务，不推进成功游标。embedding 失败独立退避，不重做摘要。
- `enabled:false` 只阻止新批次；已接纳的 queued/running 项继续按并发上限收尾，迟到成功仍可提交。恢复包括停用期间新增消息。
- 移除群范围后停止该群的新来源/摘要请求；已发出的请求可完成，不会因此清空历史。
- **停用不是立即停止所有已授权 I/O 的紧急开关。** 若必须中断运行中的服务，需要管理员单独批准操作，不能由本功能暗中部署/重启。

## 编辑、撤回和保留期限

来源检查不承诺实时全历史删除 SLA：

- `overlapHours` 内、被保留摘要引用的消息，每个已接纳话题最多检查 `min(10,maxMessagesPerBatch)` 条。
- 更老的引用按 `historicalRecheckDays` 判断到期，每个完整批次最多 `maxHistoricalChecksPerRun` 条，独立于近期预算；零表示关闭历史复核。
- 重试/续步/重启不重新分配本批预算。按上次尝试排序轮转，跨批次最短一小时重试间隔，避免失败引用永久抢预算。
- 已确认编辑立即使关联摘要失效，正常来源扫描负责重建；失败不恢复旧摘要。只把明确撤回码 `230011` 或匹配身份的 `deleted:true` 当作删除。权限不足、找不到内容、网络错误和跨话题结果都算未知，不能误删。
- `historicalRecheckDays` 是**到期阈值而非完成 SLA**；实际覆盖还取决于来源权限、日程、话题数量和独立预算。
- `retentionDays:null` 不自动到期。显式 TTL 按每条摘要最后成功更新时刻计算，到期清理摘要及向量/相关 embedding 任务；保留目录、来源日期、成功游标与幂等证据。后台每 tick 有界处理 20 个话题，维护游标持久恢复。
- 停用不清空历史，但已显式配置的 TTL 仍执行本地清理。若希望停用后无限保留，另将 TTL 改为 null。

完整派生数据清理是独立管理动作：先经管理员批准停止相关 Dashboard 后台写入，备份 `topic-search` 目录，确认无活跃写者，再移走整个目录（包括 SQLite WAL/SHM）。不要在线单独删除主 SQLite 文件，不要删除 Session 库、原消息或用户 `summary.md`。再次启用且目录为空会重新建立目录/首轮覆盖范围。本文没有执行此操作。

## 查询与故障观察

- 话题视图上方的查询词查摘要/关键词；内容查询不再同时用旧 session 文本过滤。其他会话筛选保留，显式会话条件可能排除没有会话的历史话题。
- 日期可以独立使用，明确选择话题创建或最新消息时间。未知时间不会用摘要时间/首次发现时间冒充。输入按浏览器本地时区转换成 UTC。
- 自动/混合检索在向量缺失、超时、模型不匹配时保留关键词结果并显示降级。分页绑定身份、授权范围、查询、模型和索引代次；过期应重新查询，不拼接旧响应。
- `GET /api/topic-search/status`（管理员认证）提供启用状态、待处理摘要任务数、待生成向量数及安全错误码。查询响应提供 coverage、未知日期、候选预算截断和降级原因；不得用命中为空证明全源已覆盖。
- `topic_model_credential_missing`：核对宿主独立凭据引用；不要改用 CLI 会话环境绕过授权。
- `topic_source_unavailable`：检查可用 daemon/应用权限/消息归属，不把来源未知当成删除。
- `topic_revision_conflict`、`stale_topic_claim`：检查是否发生维护、过期接管或并发修改；旧结果不会强行覆盖。
- `topic_source_message_over_budget`：单条消息超过输入边界，不会静默丢弃并推进游标；需要管理员按模型能力调整预算或处理源内容。

当前状态接口仍只提供粗粒度积压/错误信息；精细 token 成本、摘要延迟、跳过/失败话题计数尚需验收补齐，不能据此宣称满足完整可观测性要求。

## 离线验证及证据边界

不需要真实凭据，禁止安装依赖、启动 daemon 或使用现有服务。测试配置把 HOME/数据目录隔离到临时目录，并阻断网络与子进程。

```sh
bun run test:topic:offline
bun --bun node_modules/vitest/vitest.mjs run --config vitest.topic-offline.config.ts
bun run build
```

macOS arm64 / Node 22.23.3 与 Bun 1.4.3：上述离线测试各 239 项通过，构建通过（生产代码审查头 `c31cc031b`）。包括现有 Dashboard 分组与飞书分页行为回归。Linux、单文件编译态完整执行链及真实 CLI/IM 联调没有在本轮运行，不能用 macOS 单测代替。

视觉夹具使用生产组件/CSS 和合成数据，隔离 Playwright context 离线、阻断所有请求、无真实浏览器 profile。桌面/390px 截图无横向溢出，不等于线上手测。

```sh
TOPIC_SCREENSHOT_BROWSER=/absolute/path/to/already-installed/chrome-headless-shell \
  bun scripts/topic-offline-screenshot.tsx /tmp/topic-screenshots
```

规模基准使用新建的私有 `127.0.0.1:随机端口` HTTP 夹具，复用生产 API/search；不访问 daemon、Lark、真实模型或 live 数据。运行结束关闭端口并移除临时库。

```sh
bun scripts/topic-offline-benchmark.ts /tmp/topic-benchmark-bun
node --import tsx scripts/topic-offline-benchmark.ts /tmp/topic-benchmark-node
```

固定合成数据：1,000 话题、10,000 摘要、20 条人工编写但**未经用户确认**的相关性标签，256 维向量。数据内容 SHA256 和逐查询测量见 `docs/benchmarks/topic-search-offline-2026-11-03.json`。HTTP 服务端计时从入站到响应序列化，另记录客户端往返。基准不是完整 Dashboard 服务进程压测。

原列表过滤、关键词、混合分别测量 Top-3 和 P50/P95；每个内容查询实际扫描 1,000 个话题，无预算截断。混合使用理想化手工标签向量及 10ms 假延迟，仅证明检索融合/容量路径，**不能证明真实 embedding 的同义召回质量、在线延迟或供应商成本**。真实查询人工确认和真实模型质量评估需要后续明确授权，不用合成 100% 命中率冒充完成。
