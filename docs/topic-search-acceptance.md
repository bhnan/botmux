# 话题检索：离线验收证据与边界

日期：2026-11-03。实现基线 `6dad91621`，生产审查头 `28ca551cd` 已通过独立离线复审（blocking/should-fix/nit 均为 0）。以下是实际运行的离线证据，不是部署记录，也不代表完整平台矩阵通过。需求以 `docs/specs/changes/20261028-topic-search/change.md` §1–3 的后续澄清优先。

## 验收追踪

| ID | 已验证行为 | 仓库内行为证据 | 证据限制 |
| --- | --- | --- | --- |
| A-01 | 多 session 共用位置身份、跨群/新根分离；会话关闭/消失后持久目录仍可查询 | `identity.test.ts`、`runtime.test.ts`、`ui.test.ts`、既有 `dashboard-sessions-ui.test.ts` | 注入 session 行；没有操作真实群/会话 |
| A-02 | 同槽只接纳一次、竞争租约只一个所有者；无增量不调用摘要模型；失败轮转公平 | `jobs.test.ts`、`scheduler.test.ts`、`summary-updater.test.ts`、`config.test.ts` | 真实 SQLite、受控时钟；cron/DST 用例，不等待真实日历 |
| A-03 | add/update/noop、未知 ID/来源拒绝、幂等 receipt、CAS 与多步事务回滚 | `store.test.ts`、`jobs.test.ts`、`model-client.test.ts` | 假模型输出；真实模型语义质量未验证 |
| A-04 | 分页/模型失败不推进成功游标；同毫秒余量、固定输入上界、超时迟到结果、重启接管 | `source.test.ts`、`raw-checkpoint.test.ts`、`summary-updater.test.ts`、`scheduler.test.ts` | 来源为离线分页夹具；没有假设线上 since 参数 |
| A-05 | embedding 关闭不请求；失败单独重试；仅正文/模型变化重算；旧 hash/维度/空间无效 | `embedding.test.ts`、`search.test.ts`、`config.test.ts` | 假向量 provider；不证明真实供应商可用性 |
| A-06 | 现有 auth gate 与管理身份检查；匿名/只读拒绝；scope 先于候选预算，filters 仅缩小范围 | `api.test.ts`、`search.test.ts`；源码接线位于 Dashboard auth gate 后 | 真实 gate/API 函数；不是完整 Dashboard 进程 HTTP 登录端到端验收 |
| A-07 | 中文多词/精确错误码、词向量融合去重、独立双日期/纯日期、未知日期/预算 partial、签名分页、来源 anchor | `search.test.ts`、`ui.test.ts`；离线真实 React hook/controls 浏览器交互；固定合成基准 | 中文近义语义由手工假向量模拟；不宣称真实模型 Top-3 |
| A-08 | 缺省关闭不建库/不采集/不取凭据；独立模块和已有宿主端口；查询模型故障降级 | `runtime.test.ts`、`model-client.test.ts`、`search.test.ts`、完整 build | 未启动真实聊天 CLI/daemon；默认关闭规则不取消已接纳批次 |
| A-09 | route root 与 native thread ID 分离；fork 根独立、chat/deferred 排除；历史不随 session 搬移 | `identity.test.ts`、`runtime.test.ts`、`lark-source.test.ts` | 位置/行数据单测，不冒充真实 relay/fork 联调 |
| A-10 | 全局停用收尾但不接纳新批次；更新范围移除阻止新来源/摘要外发；可信删除/编辑原子失效与迟到任务隔离 | `scheduler.test.ts`、`source-review.test.ts`、`source-view-invalidation.test.ts`、`maintenance.test.ts` | 历史仍可检索/embedding 符合澄清，不将更新 allowlist 当历史访问范围 |

表内未带路径的测试位于 `test/topic/`。清单不是源码文本断言；测试导入真实组件，以状态、外发次数、持久结果或 React 元素行为断言。

补充 MUST 边界：

- Topic/TopicSummary 位于 `src/types.ts`，知识/调度/模型业务位于 `src/topic/`；SQLite 引擎复用 `services/sqlite-compat.ts`。浏览器身份 helper 不引入 Node 运行时。
- 不改聊天模型、不启动摘要 CLI、不提供模型工具；独立 provider/profile/凭据引用。模型响应不允许写身份/权限/游标。
- 临时原文/token 固定 24h 上限，独立于摘要 retention，停用仍本地有界回收；旧 schema 无到期值安全失效。仅摘要正文、关键词、引用、hash 等知识长期存储。
- 来源 check/page 复用已有 daemon IPC 的 trusted-host 校验；无新监听端口、独立守护进程、CLI/Skill/MCP 查询入口。
- 状态接口包含任务结果、批次时长、待生成向量、provider 报告 token/未知用量计数。字符量不是 token，未知价格不估造货币费用；没有原文/凭证/provider 错误正文回显。

## 实跑命令与结果

工作目录为当前独立实现 checkout；依赖沿用既有 node_modules，未 install。

```bash
node node_modules/vitest/vitest.mjs run --config vitest.topic-offline.config.ts
bun --bun node_modules/vitest/vitest.mjs run --config vitest.topic-offline.config.ts
bun run build
TOPIC_SCREENSHOT_BROWSER=<已安装 Chromium headless shell> bun scripts/topic-offline-interaction.ts
TOPIC_SCREENSHOT_BROWSER=<已安装 Chromium headless shell> bun scripts/topic-offline-screenshot.tsx
```

- macOS arm64，Node 22.23.3 / Bun 1.4.3：各 **22 文件 / 265 测试通过**；完整构建通过。
- 单测 setup 拒绝 fetch、HTTP(S)、TCP/TLS 及子进程；真实 SQLite 文件仅在临时目录。没有使用缺省凭据作为“离线”保证。
- 独立探针在本源码复跑：原状态 7/7、新边界 7/7、真实 React 来源导航通过。新增失效交叠九用例、七种守卫变异均咬红并恢复。问题与探针详见 `topic-search-review-fixes.md`；独立精确头复验另执行原状态 7/7、新边界 7/7、失效交叠 7/7、UI 导航及新增回归 9/9，八组守卫变异咬红，未发现新问题。
- 真实 React hook/controls + 新建离线 Chromium context：纯日期及上海时区转换、日期口径切换、忽略取消的迟到响应、分页去重/游标过期重试、来源 anchor、群过滤、mode/错误重试/停用回到原列表，九场景通过，网络请求尝试数 **0**。fixture 只替换 fetch，不连接真实 Dashboard；它不是整个 SessionsPage 端到端测试。
- 生产组件 SSR + 离线 Chromium 截图：桌面 1365px、移动 390px，无横向溢出。布局截图不证明线上交互或权限。

运行日志保存在 `/tmp/astra-independent-{tests,bun-tests,build}.log`、`/tmp/astra-r1-{original,extra,ui}-after.log`、`/tmp/astra-r1-mutation-*.log`、`/tmp/astra-topic-interaction.log`、`/tmp/astra-topic-screenshot.log`。`/tmp` 是当前工作环境证据，不是永久托管地址。

## 规模与质量：严格区分

`docs/benchmarks/topic-search-offline-2026-11-03.json` 对应 `c31cc031b` 核心代码上的固定合成 1,000 话题 / 10,000 摘要 / 20 查询。使用新建临时 loopback HTTP 夹具、生产检索/API 函数及假 provider，没有连接现有 daemon/Dashboard。

| 运行时 | keyword HTTP 入站到序列化 P95 | hybrid 同口径 P95 |
| --- | ---: | ---: |
| Node 22.23.3 | 91.97ms | 125.36ms |
| Bun 1.4.3 | 71.95ms | 107.85ms |

结果仅支持该合成规模和记录硬件下的性能观察；没有以它推断最新头或线上延迟。手工相关性标签/理想化向量的 Top-3=1.0 不是真实查询集与人工验收，不证明真实 embedding 效果、成本或网络尾延迟。

## 横向影响与未运行矩阵

- 共用改动：Lark client 提取单页请求并新增严格升序 thread 读取；旧降序分页行为回归已跑。Dashboard 加生命周期/受保护路由/设置节与页面过滤；内容命中约束与批量操作候选共用，避免操作隐藏会话。identity 从既有纯 helper 提取，无新 key 格式。
- PTY/Tmux、各 CLI runner、消息处理主链路、sandbox、Session 存储均未新增模型/调度逻辑。这里是影响面审读，不等于已实跑所有组合。
- **未运行**：Linux、单文件编译态完整运行链、至少两种真实 CLI 聊天、真实 thread/chat/关闭恢复/relay/fork、sandbox on/off 全矩阵、真实模型质量/人工 Top-3、完整 Dashboard HTTP 登录链及在线 IM 联调。
- 不启动 Docker/VM 代替用户授权；本机既有 Docker endpoint 不可用。未下载镜像。
- 没有部署、切全局 shim、重启 fleet、push 或发版。在线功能测试须用户另行明确批准。
