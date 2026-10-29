# 话题内容检索

Dashboard 的「话题」视图原先只能按会话标题/字段做字符串包含过滤。开启话题内容检索后，
后台会定期把每个话题的公开讨论整理成摘要与关键词，页面搜索直接命中**讨论内容**，
一个话题里多个会话的记录合并成一条结果。

功能默认关闭：不启用时页面行为、聊天链路和模型调用都与升级前完全一致。

## 开启

在 `~/.botmux/config.json` 中加入 `topicSearch` 节：

```json
{
  "topicSearch": {
    "enabled": true,
    "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
    "llmModelRef": "topic-enricher",
    "initialLookbackDays": 14,
    "maxConcurrentTopics": 1,
    "maxTopicsPerRun": 20,
    "recheckOverlapHours": 24
  }
}
```

- `allowedChatIds`：**更新范围**，只整理这些群的话题。它不是检索准入：群移出更新范围后，已保留的历史摘要仍可被检索；页面可见范围由 Dashboard 认证决定。
- `llmModelRef`：配置里的引用名；真正的连接来自 Dashboard 进程环境：

```sh
export BOTMUX_TOPIC_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export BOTMUX_TOPIC_LLM_MODEL="your-summary-model"
export BOTMUX_TOPIC_LLM_API_KEY="..."
```

摘要与关键词共用一次结构化模型调用，独立于聊天 Bot 的模型，不携带任何工具权限。
凭证不会写进配置文件，也不会进入检索库或日志。

可选向量检索默认关闭。关闭时只用关键词；开启时需要额外的 embedding 端点：

```json
{
  "topicSearch": {
    "embedding": { "enabled": true, "modelRef": "topic-embedding" }
  }
}
```

```sh
export BOTMUX_TOPIC_EMBEDDING_BASE_URL="https://your-openai-compatible-endpoint/v1"
export BOTMUX_TOPIC_EMBEDDING_MODEL="your-embedding-model"
```

## 调度

默认每天 02:00（`Asia/Shanghai`）。也可以改成周期：

```json
{ "schedule": { "kind": "interval", "intervalMinutes": 120 } }
```

每轮只处理有新增消息的话题；没有增量时不调用模型。摘要、关键词与成功游标一起提交，
失败（模型超时、分页不完整、提交冲突）不推进游标，下一轮重试。后台任务不影响聊天、
会话恢复和发消息。

关闭后台调度在下一次调度检查生效（无需重启，在途任务会完成）。若功能在本次进程启动后才关闭，重新开启无需重启；若启动时就是关闭状态，重新开启需要重启 Dashboard 启动调度器。查询接口每次请求都会读当前配置。

## 页面行为

- 在「话题」视图输入非空关键词即触发内容检索；结果按话题去重，一个话题只出现一次。
- 命中摘要、更新时间、partial（仍有话题未建索引）与降级原因都会展示。
- 结果多时点「加载更多」翻页；清空关键词立即回到原来的本地列表。
- 原状态、Bot、CLI、群筛选继续生效；历史话题即使没有现存会话行也能显示标题、摘要和入口。
- 检索失败或功能关闭时自动回退到原字符串筛选，不会把页面卡住。

## 观察与停用

Dashboard 日志中搜索 `[topic-search]` 可以看到每轮检查/更新/跳过/失败计数和错误码。
索引本体在 `<数据目录>/topic-search.sqlite`（默认 `~/.botmux/data/`），只存摘要、关键词、
来源消息 id 与可选向量，不存原始聊天记录。

停用：

```json
{ "topicSearch": { "enabled": false } }
```

改为关闭后下一次调度检查即停止新任务，页面回退到原搜索，已生成的数据保留。已经启动的模型任务会
正常跑完并推进成功游标；重新开启后从上次成功游标继续增量（含停用期间新增的消息），
不全量重做。需要清空时在停用后删除 `topic-search.sqlite*` 即可，不会影响任何会话或飞书消息。

## 已知边界

- 只整理部署里存在可读 Bot 会话的 thread 话题；chat、DM 和无根消息会话跳过。
- 删除检测每轮复查游标之前 `recheckOverlapHours`（默认 24 小时，最多 200 条）的已摘要消息；更早的历史删除不保证立即从所有结果消失，窗口被预算截断时只处理源侧显式标记的删除；退化为按根消息扫群（拿不到原生话题 id）时不做「缺席即删除」判定，避免误删存活摘要。
- 覆盖范围只描述当前部署已知的话题目录，不代表整个飞书租户。
- 在固定合成数据集（1,000 话题 / 10,000 摘要 / 20 条查询）上，关键词检索 P95 约 22 ms、Top-3 100%；这些查询带唯一实体词，只说明召回机制与延迟，不代表真实语义质量。
