# Topic Content Search

The Dashboard's Topics view used to filter sessions by substring-matching session fields. With topic content search enabled, a background job periodically turns each topic's public discussion into summaries and keywords, so page searches match the **discussion content**, with multiple sessions in one topic merged into a single result.

The feature is off by default: when disabled, the page, chat paths, and model usage behave exactly as before.

## Enable it

Add a `topicSearch` section to `~/.botmux/config.json`:

```json
{
  "topicSearch": {
    "enabled": true,
    "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
    "llmModelRef": "topic-enricher",
    "initialLookbackDays": 14,
    "maxConcurrentTopics": 1,
    "maxTopicsPerRun": 20
  }
}
```

- `allowedChatIds`: only topics in these chats are indexed, and page searches only recall within this scope.
- `llmModelRef`: a reference name; the real connection comes from the Dashboard process environment:

```sh
export BOTMUX_TOPIC_LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export BOTMUX_TOPIC_LLM_MODEL="your-summary-model"
export BOTMUX_TOPIC_LLM_API_KEY="..."
```

Summaries and keywords share one structured model call, independent of any chat Bot's model, and carry no tool permissions. Credentials are never written to the config file, the search store, or logs.

Optional vector search is off by default. Without it, search is keyword-only; enabling it needs an embedding endpoint:

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

## Schedule

The default is daily at 02:00 (`Asia/Shanghai`). An interval is also supported:

```json
{ "schedule": { "kind": "interval", "intervalMinutes": 120 } }
```

Each run only processes topics with new messages; when there is no increment, no model is called. Summaries, keywords, and the success cursor commit together. Failures (model timeout, incomplete pagination, commit conflict) do not advance the cursor and are retried next run. Background work never blocks chatting, session recovery, or replies.

Enabling/disabling the background schedule requires a Dashboard restart; the query endpoint reads the current config on every request.

## In the page

- Typing a non-empty query in the Topics view triggers content search; results are deduplicated per topic.
- Matching summaries, update time, partial coverage (topics not indexed yet), and degradation reasons are shown.
- "Load more" pages through further results; clearing the query restores the original local list.
- Status, Bot, CLI, and chat filters still apply; archived topics with no remaining session rows still show a title, summaries, and an entry.
- On failure or when the feature is disabled, the page falls back to the original substring filter instead of getting stuck.

## Observing and disabling

Search Dashboard logs for `[topic-search]` to see per-run checked/updated/skipped/failed counts and error codes. The index lives at `<data dir>/topic-search.sqlite` (default `~/.botmux/data/`) and stores summaries, keywords, source message ids, and optional vectors — never raw chat history.

Disable it with:

```json
{ "topicSearch": { "enabled": false } }
```

After a Dashboard restart the background job stops and the page falls back to the original search; existing data is retained. To remove it, disable the feature and delete `topic-search.sqlite*`; no session or Lark message is affected.

## Known limits

- Only thread topics with a readable Bot session in this deployment are indexed; chats, DMs, and sessions without a root message are skipped.
- Deletion detection re-checks the 24 hours (up to 200 messages) before the current cursor each run; older historical deletions are not guaranteed to disappear from every result immediately, and a budget-truncated window only honours explicit deletion markers from the source.
- Coverage describes this deployment's known topic directory, not the whole Lark tenant.
- On a fixed synthetic dataset (1,000 topics / 10,000 summaries / 20 queries), keyword search measured P95 ≈ 33 ms with a 100% Top-3 rate; those queries carry unique entity tokens, so this shows retrieval mechanics and latency, not real semantic quality.
