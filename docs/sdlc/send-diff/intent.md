# send --diff

## Background and problem
用户要求把文档 diff 格式化固定到代码，并明确与现有 --attention 的入口与代码风格保持一致。

## Users
在 BotMux/飞书交付文档修改结果的 Agent 和用户。

## Goals and core requirements
提供核心 `botmux send --diff <统一diff文件> [摘要]`；在 services/send-policy.ts 解析和校验参数，使用纯渲染器，在已有 send 卡片路径交付。支持现有 mention/final 和安全的 dry-run。

## Constraints and assumptions
基于当前远端 fdd7d8d（2026-10-29）。所有源码、依赖、构建、记录保存于当前任务。使用已有统一 diff；不修改源文档。完整 diff 附件由 Agent 在 final 前单独交付，保持既有原始卡片与附件互斥契约。

## Success criteria and verification
解析、统计、转义、Unicode、空行、长预览、malformed 输入测试通过；dry-run 不依赖会话且不发消息；真实 send 集成测试覆盖最终页脚、@、回放和至少两种 CLI/会话组合；bun run build 成功。

## Non-goals
插件入口、悬停、等宽彩色代码块、改写权限或投递账本、公开发布。

## Open questions / decision record
用户补充消息已明确授权核心参数实现；原插件入口不部署，纯渲染器作为已验证原型复用。
