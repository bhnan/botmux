# send --diff specification

## Scope and intent traceability
新增 --diff 文件参数，与 --attention 同属 send 的核心可选参数。允许 --diff=path；重复、空值、stdin 别名、与原始卡片输入或媒体混用在解析时拒绝。

## Current-state context
cmdSend 先处理 help/dry-run，再处理身份、relay、VC 和既有卡片发送。使用已有纯函数式 policy 返回 requested/path/error 与 usageError。

## Proposed behavior and user flows
接收已有 unified diff，生成每文件折叠面板，+N/-M、红绿上下文、Markdown 转义和 nbsp 缩进，整卡约 18KB 预算。正文使用 send 原有的 content-file > positional > stdin 优先级作为摘要；在既有参数校验和正文读取处生成 diff 卡片，直接进入原有发送流程。

## Architecture and data flow
src/services/send-policy.ts：parseDiffFlag/diffUsageError；src/im/lark/diff-card.ts：纯解析/渲染；src/cli.ts：命令执行、普通正文读取、有界 UTF-8 diff 文件读取、dry-run、help；src/skills/definitions.ts：推荐 native 命令。

## Interfaces, schemas, and permissions
生成纯展示 schema 2.0，无 callback。dry-run 只本地解析并返回 JSON，不走会话/relay/provider。真实发送经过既有授权、路由、final、mention、预期链接、幂等和回放处理。与 --layout、--as、文档评论等组合沿用既有卡片边界。

## Failure modes and edge cases
2MiB 输入限制、严格 UTF-8、hunk 数字和行数验证、Git quoted UTF-8、增删文件、rename/binary 说明、行数和字节双重截断。空 diff 不伪造变化。媒体/附件先单独交付再 final；不新增上传或补偿写操作。

## Security, compliance, and operational rules
用户内容仅作数据，无 shell。原始 diff 在调用时读取一次并作为确定性渲染输入。不会改变身份或 durable outbox 语义。live daemon 切换需单独授权（可能影响同机所有 Bot），实现和验证完成后再提交具体部署结果。

## Test, rollout, and rollback strategy
复用原型有效行为用例，将核心策略测试并入现有 send-policy 套件，增加实际 CLI dry-run、fake provider final 和受约束 relay 发送集成测试。bun 1.4.3 冻结依赖，bun run build。保留 patch、构建日志和上一版 skill；全局部署前提供具体命令和回滚路径。

## Decisions and alternatives
根据用户明确要求采用核心参数；不会安装原型插件。既有发送状态语义保持不变，diff 是输入格式适配。

## 命令层一致性重构

按照用户要求删除独立 send-diff.ts 与 argv 改写层。diff 与 attention/urgent 的参数策略同位于 send-policy.ts，执行同位于 cli.ts；纯卡片解析渲染保留于 im/lark。policy 测试合并到已有 send-policy.test.ts，摘要和输入行为使用真实 CLI 测试。relay 将生成卡片放入原有 cardFile 协议，不新增宿主 flag 或身份通道。
