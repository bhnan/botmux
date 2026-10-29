# send --diff 验证记录

## 最终修改

增加核心 `botmux send --diff <文件> [摘要]`。参数解析和限制位于 `send-policy.ts`，文件读取和执行留在 `cli.ts`；普通 Markdown 与 diff 卡片统一在 `md-card.ts`，共用 `createReplyCard()`、卡片配置及摘要正文渲染。

复用原有身份校验、引用、@、final、回放和受约束 `cardFile` relay；没有新增命令框架或独立卡片模块，也没有改变 daemon 生命周期或 CLI 适配器。

## 验证结果

- 开发版 `bun run build` 通过，包含类型检查、Dashboard 构建和资产审计。
- 相关13个测试文件：448 项通过，2 项既有 Linux 专用用例在 macOS 跳过。
- `v3.54.0 + 本次功能` 的本机试用候选：264 项核心相关检查及完整构建通过。
- 覆盖普通卡片/共享配置、diff 计数、UTF-8/中文路径、转义、缩进、空行、多 hunk、增删文件、元数据、截断预算、摘要优先级、无会话 dry-run、final/@/回放以及受约束 relay。
- hunk 完整性守卫变异复验能够检出缺失校验；源码在验证后逐字节恢复。

验证命令：

```bash
bun run build
bun x vitest run --project unit test/md-card.test.ts test/send-policy.test.ts test/cli-send-diff.test.ts test/cli-send-dry-run.test.ts test/cli-send-custom-final.test.ts test/cli-send-dispatch.test.ts test/send-content.test.ts test/cli-send-link-ref.test.ts test/sandbox-relay-watcher.test.ts test/sandbox-relay-link-ref.test.ts test/reply-style-guide.test.ts test/skill-injection-mode.test.ts test/builtin-skills.test.ts
```

## 本机试用与展示

已在本机切换 `v3.54.0 + 本次功能` 的试用构建，14 个机器人 daemon 及 Dashboard 均恢复在线。原生 `send --diff` 的两文件演示实际发送成功，本机试用整体反馈展示效果可用。

展示示意位于 `docs/assets/send-diff-preview.png`，依据命令实际生成的 schema 2.0 卡片绘制，展示展开状态；这是排版示意，非飞书客户端截图。

## 已知边界

彩色行使用比例字体，长行换行；上下文灰色和缩进的客户端特定边界仍需逐项视觉验收。没有在真实 OS sandbox 中执行端到端验证；现有 relay 协议的CLI集成和回归已通过。未进行外部代码审查。

提交只新增展示输入，权限、投递状态和回放语义使用既有实现；本机保留原二进制与技能备份，可回滚。当前用户已授权提交草稿 PR；正式发布和合并仍属于后续步骤。
