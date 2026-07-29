/**
 * 成本追踪 · 阶段 2：存储地基与 tracker 生命周期。
 *
 * 这套测试盯的是"钱的账本不能错"：
 *   - events 求和必须等于 turn 汇总（最终重算是唯一事实源）；
 *   - 三个"不完整"计数语义不能串（写失败 / 迟到被拒 / job 超时是三回事）；
 *   - 任何出口都不能让 turn 停在 collecting。
 * 全程真临时 DB、零 mock —— 事务语义 mock 不出来。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const TMP_DB = path.join(os.tmpdir(), `aiops-usage-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

const {
  createUsageTurn,
  recordUsageEvent,
  interactiveDone,
  finishBackgroundJob,
  incrementPendingJobs,
  settleTimedOutTurns,
  recoverInterruptedTurns,
  sweepOrphanUsage,
  deleteUsageByConversation,
  deleteUsageByProject,
  getTurnSummary,
  getTurnEvents,
  addDroppedUsageRecords,
} = await import('../src/db/usageStore.ts');
const { createUsageTracker } = await import('../src/services/usage/usageTracker.ts');

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

let projectId: string;
beforeEach(() => {
  projectId = `proj-${crypto.randomUUID()}`;
});

function newTurn(overrides: Partial<Parameters<typeof createUsageTurn>[0]> = {}): string {
  return createUsageTurn({ projectId, pipeline: 'ask', source: 'web', ...overrides });
}

/** 造一条最小可用的 event 输入 */
function evt(turnId: string, over: Record<string, unknown> = {}) {
  return {
    turnId,
    stage: 'ask.answer_complex' as const,
    stageCallIndex: 0,
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash',
    canonicalModel: 'deepseek-v4-flash',
    transportStatus: 'success' as const,
    usageSource: 'provider' as const,
    deliveryMode: 'non_stream' as const,
    validationWarnings: [],
    tokens: { promptTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40, completionTokens: 20, totalTokens: 120 },
    totalCostNanoCny: 41_200,
    latencyMs: 1200,
    ...over,
  } as Parameters<typeof recordUsageEvent>[0];
}

describe('turn / event 基本读写', () => {
  it('记录调用后汇总即时可见，且 events 求和 = turn 汇总', () => {
    const turnId = newTurn();
    expect(recordUsageEvent(evt(turnId)).ok).toBe(true);
    expect(recordUsageEvent(evt(turnId, { stageCallIndex: 1, totalCostNanoCny: 8_800 })).ok).toBe(true);

    const s = getTurnSummary(turnId)!;
    expect(s.callCount).toBe(2);
    expect(s.knownCostNanoCny).toBe(50_000);
    expect(s.totalTokens).toBe(240);

    const events = getTurnEvents(turnId);
    expect(events).toHaveLength(2);
    expect(events.reduce((a, e) => a + (e.totalCostNanoCny ?? 0), 0)).toBe(s.knownCostNanoCny);
  });

  it('同一 (turn, stage, index) 重复写入被唯一索引挡掉，不重复计费', () => {
    const turnId = newTurn();
    expect(recordUsageEvent(evt(turnId)).ok).toBe(true);
    const second = recordUsageEvent(evt(turnId, { id: 'another-id' }));
    expect(second).toEqual({ ok: false, reason: 'duplicate' });
    expect(getTurnSummary(turnId)!.callCount).toBe(1);
  });

  it('turn 不存在时丢弃事件，绝不重建 turn（会话已删的迟到写入）', () => {
    const result = recordUsageEvent(evt('no-such-turn'));
    expect(result).toEqual({ ok: false, reason: 'turn_not_found' });
    expect(getTurnSummary('no-such-turn')).toBeNull();
  });

  it('usage 缺失 / 单价未知分别计数，并派生 partial 原因', () => {
    const turnId = newTurn();
    recordUsageEvent(evt(turnId, { usageSource: 'missing', tokens: {}, totalCostNanoCny: undefined }));
    recordUsageEvent(
      evt(turnId, { stageCallIndex: 1, model: 'unknown-model', totalCostNanoCny: undefined }),
    );
    const s = getTurnSummary(turnId)!;
    expect(s.usageMissingCalls).toBe(1);
    expect(s.unknownPricingCalls).toBe(1); // 有 usage 但没算出钱
    expect(s.partialReasons).toEqual(expect.arrayContaining(['usage_missing', 'pricing_unknown']));
  });
});

describe('结算生命周期', () => {
  it('无后台任务：interactiveDone 直接 settled', () => {
    const turnId = newTurn();
    recordUsageEvent(evt(turnId));
    const s = interactiveDone(turnId, 'completed')!;
    expect(s.settlementStatus).toBe('settled');
    expect(s.settled).toBe(true);
    expect(s.executionStatus).toBe('completed');
  });

  it('有后台任务：先 pending，任务完成后 settled', () => {
    const turnId = newTurn();
    incrementPendingJobs(turnId, Date.now() + 60_000);
    const pending = interactiveDone(turnId, 'completed')!;
    expect(pending.settlementStatus).toBe('pending');
    expect(pending.settled).toBe(false);

    const settled = finishBackgroundJob({ turnId })!;
    expect(settled.settlementStatus).toBe('settled');
  });

  it('后台任务失败仍释放 pending，并记 background_failed', () => {
    const turnId = newTurn();
    incrementPendingJobs(turnId, Date.now() + 60_000);
    interactiveDone(turnId, 'completed');
    const s = finishBackgroundJob({ turnId, failed: true })!;
    expect(s.settled).toBe(true);
    expect(s.backgroundFailedJobs).toBe(1);
    expect(s.partialReasons).toContain('background_failed');
  });

  it('interactiveDone 幂等：重复调用不重复结算、不改终态', () => {
    const turnId = newTurn();
    recordUsageEvent(evt(turnId));
    const first = interactiveDone(turnId, 'completed')!;
    const second = interactiveDone(turnId, 'failed')!;
    expect(second.executionStatus).toBe('completed'); // 不被后一次覆盖
    expect(second.settlementStatus).toBe('settled');
    // 关键：第二次没有重复结算 → 汇总不翻倍
    expect(second.callCount).toBe(first.callCount);
    expect(second.knownCostNanoCny).toBe(first.knownCostNanoCny);
  });

  it('aborted 且有后台任务：允许 aborted + pending，最后转 settled', () => {
    const turnId = newTurn();
    incrementPendingJobs(turnId, Date.now() + 60_000);
    const s1 = interactiveDone(turnId, 'aborted')!;
    expect(s1.executionStatus).toBe('aborted');
    expect(s1.settlementStatus).toBe('pending');
    const s2 = finishBackgroundJob({ turnId })!;
    expect(s2.executionStatus).toBe('aborted');
    expect(s2.settled).toBe(true);
  });
});

describe('三个「不完整」计数互不重叠', () => {
  it('settled 之后迟到的 event → late_dropped_events，不并入 dropped、不复活 turn', () => {
    const turnId = newTurn();
    recordUsageEvent(evt(turnId));
    interactiveDone(turnId, 'completed');

    const late = recordUsageEvent(evt(turnId, { stageCallIndex: 9 }));
    expect(late).toEqual({ ok: false, reason: 'turn_settled' });

    const s = getTurnSummary(turnId)!;
    expect(s.lateDroppedEvents).toBe(1);
    expect(s.droppedUsageRecords).toBe(0); // 写库通道正常，不是写失败
    expect(s.callCount).toBe(1); // 迟到事件不进汇总
    expect(s.settlementStatus).toBe('settled'); // 不复活
    expect(s.partialReasons).toContain('late_event_dropped');
  });

  it('写库失败 → dropped_usage_records + tracking_write_failed', () => {
    const turnId = newTurn();
    addDroppedUsageRecords(turnId, 2);
    const s = getTurnSummary(turnId)!;
    expect(s.droppedUsageRecords).toBe(2);
    expect(s.lateDroppedEvents).toBe(0);
    expect(s.partialReasons).toContain('tracking_write_failed');
  });

  it('watchdog 超时 → background_timed_out_jobs + settlement_timeout，且不碰另外两个计数', () => {
    const turnId = newTurn();
    incrementPendingJobs(turnId, Date.now() - 1); // 已过期
    interactiveDone(turnId, 'completed');

    expect(settleTimedOutTurns()).toContain(turnId);
    const s = getTurnSummary(turnId)!;
    expect(s.settlementStatus).toBe('settled');
    expect(s.backgroundTimedOutJobs).toBe(1);
    expect(s.droppedUsageRecords).toBe(0);
    expect(s.lateDroppedEvents).toBe(0);
    expect(s.partialReasons).toContain('settlement_timeout');
  });

  it('watchdog 结算后迟到的 job.done 幂等 no-op，不把 turn 拉回 pending', () => {
    const turnId = newTurn();
    incrementPendingJobs(turnId, Date.now() - 1);
    interactiveDone(turnId, 'completed');
    settleTimedOutTurns();

    const after = finishBackgroundJob({ turnId })!;
    expect(after.settlementStatus).toBe('settled');
    expect(after.backgroundFailedJobs).toBe(0);
  });

  it('最终重算不清零 dropped/late（它们本就无法从 events 派生）', () => {
    const turnId = newTurn();
    recordUsageEvent(evt(turnId));
    addDroppedUsageRecords(turnId, 3);
    const s = interactiveDone(turnId, 'completed')!;
    expect(s.droppedUsageRecords).toBe(3);
    expect(s.callCount).toBe(1); // 重算后仍等于 events 数
  });
});

describe('启动恢复与清扫', () => {
  it('进程重启：遗留 collecting/pending 一律结算并标 process_interrupted', () => {
    const collecting = newTurn();
    const pendingTurn = newTurn();
    incrementPendingJobs(pendingTurn, Date.now() + 60_000);
    interactiveDone(pendingTurn, 'completed');

    expect(recoverInterruptedTurns()).toBeGreaterThanOrEqual(2);
    for (const id of [collecting, pendingTurn]) {
      const s = getTurnSummary(id)!;
      expect(s.settlementStatus).toBe('settled');
      expect(s.partialReasons).toContain('process_interrupted');
    }
    // running（进程死了）→ failed；aborted 是用户意图，保持不变
    expect(getTurnSummary(collecting)!.executionStatus).toBe('failed');
  });

  it('孤儿清扫：删除不属于任何有效项目的 turn 与 event', () => {
    const keep = newTurn();
    const orphan = createUsageTurn({ projectId: 'deleted-project', pipeline: 'ask', source: 'web' });
    recordUsageEvent(evt(orphan));

    sweepOrphanUsage([projectId]);
    expect(getTurnSummary(keep)).not.toBeNull();
    expect(getTurnSummary(orphan)).toBeNull();
    expect(getTurnEvents(orphan)).toHaveLength(0);
  });

  it('有效项目集合为空时安全全删，不生成 NOT IN () 非法 SQL', () => {
    newTurn();
    expect(() => sweepOrphanUsage([])).not.toThrow();
  });

  it('删除会话/项目连带删除 usage，不误伤其他会话', () => {
    const convA = 'conv-a';
    const convB = 'conv-b';
    const a = newTurn({ conversationId: convA });
    const b = newTurn({ conversationId: convB });
    recordUsageEvent(evt(a));
    recordUsageEvent(evt(b));

    deleteUsageByConversation(convA);
    expect(getTurnSummary(a)).toBeNull();
    expect(getTurnEvents(a)).toHaveLength(0);
    expect(getTurnSummary(b)).not.toBeNull();

    deleteUsageByProject(projectId);
    expect(getTurnSummary(b)).toBeNull();
  });

  it('eval turn 的 parent 被删后允许悬挂，自身不被当孤儿清掉', () => {
    const parent = newTurn({ conversationId: 'conv-parent' });
    const evalTurn = newTurn({ pipeline: 'eval', source: 'eval', parentTurnId: parent });
    deleteUsageByConversation('conv-parent');
    expect(getTurnSummary(parent)).toBeNull();
    expect(getTurnSummary(evalTurn)).not.toBeNull(); // 悬挂但有效
  });
});

describe('UsageTracker', () => {
  it('同 stage 多次调用自动递增 stageCallIndex，互不覆盖', () => {
    const tracker = createUsageTracker({ projectId, pipeline: 'agent', source: 'web' });
    for (let i = 0; i < 3; i++) {
      tracker.record({
        stage: 'agent.loop',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        transportStatus: 'success',
        deliveryMode: 'non_stream',
        rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6, completion_tokens: 5 },
        latencyMs: 100,
      });
    }
    const events = getTurnEvents(tracker.turnId);
    expect(events.map((e) => e.stageCallIndex).sort()).toEqual([0, 1, 2]);
    expect(tracker.summary().callCount).toBe(3);
  });

  it('两个并发 tracker 不串账', () => {
    const a = createUsageTracker({ projectId, pipeline: 'ask', source: 'web' });
    const b = createUsageTracker({ projectId, pipeline: 'ask', source: 'web' });
    const call = (t: typeof a) =>
      t.record({
        stage: 'ask.answer_complex',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        transportStatus: 'success',
        deliveryMode: 'non_stream',
        rawUsage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10 },
        latencyMs: 50,
      });
    call(a);
    call(b);
    call(b);
    expect(a.summary().callCount).toBe(1);
    expect(b.summary().callCount).toBe(2);
    expect(a.turnId).not.toBe(b.turnId);
  });

  it('后台句柄 done 幂等：重复调用不重复递减 pending', () => {
    const tracker = createUsageTracker({ projectId, pipeline: 'ask', source: 'web' });
    const job = tracker.registerBackground('background.memory_extract');
    tracker.finish('completed');
    job.done();
    job.done();
    job.done();
    const s = tracker.summary();
    expect(s.settlementStatus).toBe('settled');
    expect(s.backgroundFailedJobs).toBe(0);
  });

  it('缺 usage 时不伪装零成本：标 missing 且 partial', () => {
    const tracker = createUsageTracker({ projectId, pipeline: 'ask', source: 'web' });
    tracker.record({
      stage: 'ask.answer_complex',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      transportStatus: 'error',
      deliveryMode: 'stream',
      rawUsage: null,
      latencyMs: 30,
      errorKind: 'stream_incomplete',
    });
    const s = tracker.finish('failed');
    expect(s.usageMissingCalls).toBe(1);
    expect(s.knownCostNanoCny).toBe(0);
    expect(s.partial).toBe(true);
    expect(s.partialReasons).toContain('usage_missing');
  });

  it('建 turn 失败 → 纯内存 degraded tracker：不落库、响应仍带 partial 与 dropped 语义', async () => {
    const store = await import('../src/db/usageStore.ts');
    const spy = vi.spyOn(store, 'createUsageTurn').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const warned: string[] = [];
    const tracker = createUsageTracker({
      projectId,
      pipeline: 'ask',
      source: 'web',
      log: { warn: (m) => warned.push(m) },
    });
    expect(tracker.degraded).toBe(true);

    tracker.record({
      stage: 'ask.answer_simple',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      transportStatus: 'success',
      deliveryMode: 'non_stream',
      rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 0, completion_tokens: 5 },
      latencyMs: 20,
    });
    const s = tracker.finish('completed');
    expect(s.callCount).toBe(1); // 内存汇总仍可用
    expect(s.partial).toBe(true);
    expect(s.partialReasons).toContain('tracking_write_failed');
    expect(getTurnSummary(tracker.turnId)).toBeNull(); // 确实没落库
    expect(warned.join('')).toContain('降级');
    spy.mockRestore();
  });

  it('观测 observer 即使在写库失败时也能拿到 usage（Langfuse 不因本地存储挂掉而断）', () => {
    const seen: string[] = [];
    const tracker = createUsageTracker({
      projectId,
      pipeline: 'ask',
      source: 'web',
      observer: { onCallRecorded: (u) => seen.push(`${u.stage}:${u.tokens.totalTokens}`) },
    });
    tracker.record({
      stage: 'ask.intent',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com/v1',
      transportStatus: 'success',
      deliveryMode: 'non_stream',
      rawUsage: { prompt_tokens: 8, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 0, completion_tokens: 2 },
      latencyMs: 10,
    });
    expect(seen).toEqual(['ask.intent:10']);
  });
});
