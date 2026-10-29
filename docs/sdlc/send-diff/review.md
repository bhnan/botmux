# send --diff 验证记录

## 修改范围

在 master 的 fdd7d8d 基础上增加核心 send --diff 输入模式。
参数解析和互斥校验与 attention/urgent 同属 send-policy；文件读取和命令执行在 cli；纯解析和卡片渲染在 diff-card。diff 使用 send 原有的正文读取、身份、路由、final、mention 与回放流程。
同步更新内置技能及 help，增加解析、边界和 CLI 集成测试。

## 初版已完成验证

- bun run build：通过，包含主源码、脚本和测试 mock 的类型检查、Dashboard 构建及资产审计。
- bun x vitest run --project unit test/diff-card.test.ts test/send-diff.test.ts test/cli-send-diff.test.ts test/send-policy.test.ts test/cli-send-dry-run.test.ts test/cli-send-custom-final.test.ts test/cli-send-dispatch.test.ts test/reply-style-guide.test.ts test/skill-injection-mode.test.ts test/builtin-skills.test.ts：10 个文件、244 项检查全部通过。
- 新增 23 个用例：真实计数、UTF-8 和中文路径、转义、空行、多个 hunk、增删文件、元数据、截断和预算、输入验证、摘要优先级以及真实 CLI dry-run/final。
- Codex 话题与 Claude Code 群会话的集成验证：final 页脚和触发者 mention 各一次；重复调用回放已有结果，不重复发送。
- 删除 hunk 完整性守卫的变异复验：测试失败；验证后源码逐字节恢复。
- 在已安装的 v3.54.0 基线上应用同一功能补丁，并再次通过同一组 244 项检查和完整构建。

## 复核与限制

已核对请求体预算与普通 send 一致；无效输入在等待 stdin 前拒绝。
实现没有更改消息投递状态语义，也没有修改 CLI 适配器或 daemon 生命周期。
新增 CLI → cardFile outbox 的 relay 集成验证，确认生成卡片及摘要正确、出站请求不携带任意源文件路径。没有在真实 OS sandbox 中执行端到端验证。
飞书客户端上下文灰色和缩进效果仍需视觉验收；接口接受不代表客户端验收完成。
本记录来自实现后的静态复核、行为测试与变异复验，尚未进行外部代码审查。

## 交付状态

仅提交本地功能 commit；PR 与远端推送暂缓。
全局 CLI 与共享 daemon 尚未切换，原生 --diff 未部署。

## 命令层重构

删除 src/cli/send-diff.ts 的独立参数遍历和 argv 转换；policy 测试合并，摘要/输入验证转为 CLI 行为测试。执行路径保留摘要供 attention 的 reason 校验使用。额外覆盖已有 cardFile outbox 协议，确认 relay 不携带任意源文件路径。重构后相关 13 个测试文件 288 项通过，2 个既有 Linux 专用用例在 macOS 跳过；开发版与 v3.54.0 部署候选均完成 bun run build。候选基线另通过核心 policy、render 和 CLI 集成共 104 项。

重构运行代码从新增 352 行减为新增 321 行，净减 31 行；移除 64 行独立命令处理文件及重复 argv 遍历。原 parse/render 卡片模块未增加逻辑。
