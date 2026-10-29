/** 单话题更新编排（spec §5.2/§5.3/§5.4）：
 *  - 无增量零模型调用；有增量提交成功推进游标（noop 也推进）
 *  - 模型失败/校验失败：游标不动
 *  - CAS 冲突：并发未破坏引用则重试提交；引用失效则携新上下文重调模型一次
 *  - 引用消息消失（完整窗口）：失效关联摘要，游标不推进（本轮不总结新消息）
 *  - 截断窗口不做删除核对
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TopicStore, type SummaryMutation } from '../src/topic/store.js';
import { updateTopicFromWindow } from '../src/topic/summary-updater.js';
import type { TopicModelCallInput, TopicModelCallResult } from '../src/topic/model-client.js';
import type { TopicHistoryWindow, SourceMessage } from '../src/topic/source.js';

let tempDir: string;
let store: TopicStore;

const T0 = '2026-10-29T00:00:00.000Z';
const BASE = Date.parse(T0);

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'topic-updater-test-'));
  store = await TopicStore.open(tempDir);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedTopic() {
  return store.ensureTopic({
    topicKey: 'thread:oc_a:om_root1', chatId: 'oc_a', rootMessageId: 'om_root1',
    title: '话题', accessPolicyRef: 'chat:oc_a',
  }, T0).topic;
}

function windowOf(messages: SourceMessage[], truncated = false): TopicHistoryWindow {
  return { messages, truncated };
}

function m(id: string, atMs = BASE, text = `msg-${id}`): SourceMessage {
  return { messageId: id, senderType: 'user', createTimeMs: atMs, text };
}

function mutationFromModel(mutations: SummaryMutation[]): TopicModelCallResult {
  return { ok: true, mutations, generatorKey: 'test-model/v1' };
}

function deps(callModel: (input: TopicModelCallInput) => Promise<TopicModelCallResult>, nowIso = T0) {
  return { store, callModel, now: () => nowIso };
}

describe('updateTopicFromWindow', () => {
  it('无增量：零模型调用', async () => {
    const topic = seedTopic();
    let calls = 0;
    const outcome = await updateTopicFromWindow(deps(async () => { calls++; return { ok: false, code: 'invalid_output' }; }), {
      topicKey: topic.topicKey, window: windowOf([m('om_1')]),
    }, { firstRunSinceMs: BASE - 1 });
    // firstRunSinceMs=BASE-1 → om_1 在窗口内 → 有增量。换空窗口测无增量：
    expect(calls).toBe(1);
    const noNew = await updateTopicFromWindow(deps(async () => { calls++; return { ok: false, code: 'invalid_output' }; }), {
      topicKey: topic.topicKey, window: windowOf([]),
    }, { firstRunSinceMs: BASE - 1 });
    expect(noNew).toMatchObject({ kind: 'no_increment' });
    expect(calls).toBe(1); // 空窗口未再调用
  });

  it('有增量：提交推进游标；noop 也推进（A-04）', async () => {
    const topic = seedTopic();
    // 第一轮：add 一条
    let outcome = await updateTopicFromWindow(deps(async input => {
      expect(input.newMessages.map(x => x.messageId)).toEqual(['om_1', 'om_2']);
      return mutationFromModel([{ op: 'add', text: '事件A', keywords: ['a'], sourceMessageIds: ['om_1', 'om_2'] }]);
    }), { topicKey: topic.topicKey, window: windowOf([m('om_1'), m('om_2')]) }, { firstRunSinceMs: BASE - 1 });
    expect(outcome).toMatchObject({ kind: 'committed', added: 1 });
    let stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries).toHaveLength(1);
    expect(stored.summarizedThroughCursor).toBe('msg:om_2');
    // 第二轮新消息 om_3：模型 noop → 游标仍推进
    outcome = await updateTopicFromWindow(deps(async input => {
      expect(input.newMessages.map(x => x.messageId)).toEqual(['om_3']);
      expect(input.oldSummaries).toHaveLength(1);
      return mutationFromModel([{ op: 'noop' }]);
    }), { topicKey: topic.topicKey, window: windowOf([m('om_1'), m('om_2'), m('om_3')]) });
    expect(outcome).toMatchObject({ kind: 'committed', noop: true });
    stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries).toHaveLength(1);
    expect(stored.summarizedThroughCursor).toBe('msg:om_3');
    expect(stored.sourceThroughAt).toBe(new Date(BASE).toISOString());
  });

  it('模型失败：游标与摘要保持原状，错误码透传', async () => {
    const topic = seedTopic();
    const outcome = await updateTopicFromWindow(deps(async () => ({ ok: false, code: 'http_error' })), {
      topicKey: topic.topicKey, window: windowOf([m('om_1')]),
    }, { firstRunSinceMs: BASE - 1 });
    expect(outcome).toMatchObject({ kind: 'model_failed', code: 'http_error' });
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries).toHaveLength(0);
    expect(stored.summarizedThroughCursor).toBeUndefined();
  });

  it('CAS 冲突（并发新增摘要）：引用仍有效则按新 revision 重试提交', async () => {
    const topic = seedTopic();
    let modelCalls = 0;
    const outcome = await updateTopicFromWindow(deps(async input => {
      modelCalls++;
      if (modelCalls === 1) {
        // 模型返回前并发提交：revision 被别人推进
        store.commitSummaryUpdate({
          topicKey: topic.topicKey, expectedRevision: store.getTopic(topic.topicKey)!.revision,
          mutations: [{ op: 'add', text: '并发摘要', keywords: [], sourceMessageIds: ['om_0'] }],
          generatorKey: 'other', now: T0,
        });
      }
      return mutationFromModel([{ op: 'add', text: '我的摘要', keywords: ['k'], sourceMessageIds: ['om_1'] }]);
    }), { topicKey: topic.topicKey, window: windowOf([m('om_1')]) }, { firstRunSinceMs: BASE - 1 });
    expect(outcome).toMatchObject({ kind: 'committed' });
    expect(modelCalls).toBe(1); // 引用未失效：不重调模型，仅重试提交
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries.map(s => s.text).sort()).toEqual(['并发摘要', '我的摘要']);
    expect(stored.summarizedThroughCursor).toBe('msg:om_1');
  });

  it('CAS 冲突（并发失效了 update 目标）：携新上下文重调模型一次后提交', async () => {
    const topic = seedTopic();
    const committed = store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: store.getTopic(topic.topicKey)!.revision,
      mutations: [{ op: 'add', text: '旧摘要', keywords: [], sourceMessageIds: ['om_1'] }],
      generatorKey: 'g', now: T0,
    });
    const targetId = committed.summaries[0].id;
    let modelCalls = 0;
    const outcome = await updateTopicFromWindow(deps(async input => {
      modelCalls++;
      if (modelCalls === 1) {
        // 模型返回前并发删除目标摘要（如权限失效路径）
        store.invalidateSummaries(topic.topicKey, [targetId], T0);
        return mutationFromModel([{ op: 'update', id: targetId, text: '更新', keywords: [], sourceMessageIds: ['om_2'] }]);
      }
      // 第二次调用应拿到失效后的（空）旧摘要上下文
      expect(input.oldSummaries).toHaveLength(0);
      return mutationFromModel([{ op: 'add', text: '重建摘要', keywords: [], sourceMessageIds: ['om_2'] }]);
    }), { topicKey: topic.topicKey, window: windowOf([m('om_1'), m('om_2')]) }, { firstRunSinceMs: BASE - 1 });
    expect(outcome).toMatchObject({ kind: 'committed' });
    expect(modelCalls).toBe(2);
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries.map(s => s.text)).toEqual(['重建摘要']);
    expect(stored.summarizedThroughCursor).toBe('msg:om_2');
  });

  it('引用消息从完整窗口消失：失效关联摘要且本轮不总结新消息（游标不动）', async () => {
    const topic = seedTopic();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: 1,
      mutations: [{ op: 'add', text: '引用了 om_1 的摘要', keywords: [], sourceMessageIds: ['om_1'] }],
      generatorKey: 'g', now: T0, summarizedThroughCursor: 'msg:om_1', sourceThroughAt: T0,
    });
    // 窗口里 om_1 已消失（被撤回），只有 om_2
    let modelCalls = 0;
    const outcome = await updateTopicFromWindow(deps(async () => { modelCalls++; return mutationFromModel([{ op: 'noop' }]); }), {
      topicKey: topic.topicKey, window: windowOf([m('om_2')]),
    });
    expect(outcome.kind).toBe('invalidated');
    if (outcome.kind === 'invalidated') expect(outcome.removedSummaryIds).toHaveLength(1);
    expect(modelCalls).toBe(0); // 先失效再谈增量：本轮没有模型调用
    const stored = store.getTopic(topic.topicKey)!;
    expect(stored.summaries).toHaveLength(0);
    expect(stored.summarizedThroughCursor).toBe('msg:om_1'); // 不推进
    // 下一轮（无消失引用）正常处理 om_2 增量
    const next = await updateTopicFromWindow(deps(async () => mutationFromModel([{ op: 'add', text: '新事件', keywords: [], sourceMessageIds: ['om_2'] }])), {
      topicKey: topic.topicKey, window: windowOf([m('om_2')]),
    });
    expect(next).toMatchObject({ kind: 'committed' });
    expect(store.getTopic(topic.topicKey)!.summarizedThroughCursor).toBe('msg:om_2');
  });

  it('截断窗口不做删除核对（窗口外引用不误伤）', async () => {
    const topic = seedTopic();
    store.commitSummaryUpdate({
      topicKey: topic.topicKey, expectedRevision: 1,
      mutations: [{ op: 'add', text: '引用 om_1', keywords: [], sourceMessageIds: ['om_1'] }],
      generatorKey: 'g', now: T0, summarizedThroughCursor: 'msg:om_1', sourceThroughAt: T0,
    });
    // 截断窗口只包含 om_2（om_1 在窗口外但未消失）
    const outcome = await updateTopicFromWindow(deps(async () => mutationFromModel([{ op: 'add', text: 'om_2 事件', keywords: [], sourceMessageIds: ['om_2'] }])), {
      topicKey: topic.topicKey, window: windowOf([m('om_2')], true),
    });
    expect(outcome).toMatchObject({ kind: 'committed' });
    expect(store.getTopic(topic.topicKey)!.summaries).toHaveLength(2);
  });

  it('开启 embedding 时同事务入队向量任务', async () => {
    const topic = seedTopic();
    await updateTopicFromWindow(deps(async () => mutationFromModel([{ op: 'add', text: '向量事件', keywords: [], sourceMessageIds: ['om_1'] }])), {
      topicKey: topic.topicKey, window: windowOf([m('om_1')]),
    }, { firstRunSinceMs: BASE - 1, embeddingModelKey: 'emb/v1' });
    const jobs = store.claimDueJobs({ now: T0, owner: 'w', leaseTtlMs: 1000, limit: 10, kinds: ['embedding'] });
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { modelKey: string }).modelKey).toBe('emb/v1');
  });
});
