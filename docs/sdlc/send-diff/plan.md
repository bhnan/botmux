# send --diff implementation plan

## Preconditions and approved inputs
2026-10-29T11:13:02+08:00，用户补充明确要求“具体实现和 --attention 代码风格保持一致”，授权当前核心实现计划。

## Planned changes by file/component
新增 diff-card.ts 和 send-diff.ts；在 send-policy.ts 添加 parseDiffFlag/diffUsageError；cmdSend 在既有边界内准备原始卡片，sendDryRun 分支返回同一渲染结果；扩充 help 和内置技能。新增行为测试，复用实际 fixture 验证最终发送契约。

## Data, compatibility, and migration steps
无迁移；全平台同一纯代码/Node fs，无 shell，无适配器改动。对其它 CLI、线程/群、sandbox relay 的影响只限以既有 --card-json 载荷进入现有路径。

## Test and verification plan
运行 policy、render、helper、dry-run、final 集成，以及现有 send-policy/cli-send-dry-run/cli-send-custom-final/cli-send-dispatch。bun run build；必要时使用构建命令验证 --help/--diff --dry-run。

## Rollout/rollback plan
按 AGENTS.md 的 switch:here 和 daemon:restart 做具体部署准备；ai-native-sdlc 要求生产替换由明确 release owner 授权，因此在所有实现与检查结束后再进行该最后确认。未授权前只运行隔离源码的读写受控验证。

## Risks and mitigations
同机 daemon 切换会波及其他 Bot；部署必须最后一步。客户端灰色与缩进保留未验证标记。已有本机技能覆盖会屏蔽新的出厂正文，需要同步更新，但先后取决于新命令部署是否完成。

## Approval record
核心代码实现已由当前用户补充请求授权；live daemon/global binary 替换尚未授权。

本地提交授权：用户要求先提交 commit 并同步范围及代码量；本轮只提交本地功能分支，PR 和运行环境部署继续暂缓。
