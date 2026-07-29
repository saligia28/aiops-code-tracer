/**
 * 请求级 UsageTracker（阶段 2）——一次任务的成本归属中心。
 *
 * 为什么显式传递而不用 AsyncLocalStorage（设计文档 §6.1）：后台 fire-and-forget 任务必须
 * 明确继承哪个 turn；stage 标签由调用方决定；单测能直接注入 fake tracker。
 *
 * 两条硬纪律：
 *   1. **成本追踪永远不能把问答搞挂**。任何存储异常都在这里被吞掉并降级为计数，不向上抛。
 *   2. **失败不许伪装成零成本**。写不进去就记 dropped，摘要里带 partial 标记，
 *      让界面说"已知部分"而不是"本轮 ¥0"。
 */
import type {
  LlmCallUsage,
  LlmPipeline,
  LlmProvider,
  LlmRequestSource,
  LlmUsageStage,
  TurnExecutionStatus,
  TurnPartialReason,
  TurnUsageSummary,
} from '@aiops/shared-types';
import {
  addDroppedUsageRecords,
  createUsageTurn,
  finishBackgroundJob,
  getTurnSummary,
  incrementPendingJobs,
  interactiveDone,
  recordUsageEvent,
} from '../../db/usageStore.js';
import { computeCost, canonicalizeModel, resolvePricing } from './pricingCatalog.js';
import { normalizeProviderUsage, type RawProviderUsage } from './normalizeUsage.js';

/** 后台任务的结算超时：长跑进程不能靠重启解卡（设计文档 §6.2） */
export function settlementTimeoutMs(): number {
  const raw = Number(process.env.LLM_USAGE_SETTLEMENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

/**
 * Langfuse 等观测后端的出口。tracker 在每次记录后通知它——
 * `lastCallMeta` 单例被移除后，Langfuse 的 usage 就靠这条路（设计文档 §11.1）。
 * ephemeral 里的字符数只在内存里传递，绝不写进 usage 表。
 */
export interface LlmUsageObserver {
  onCallRecorded(usage: LlmCallUsage, ephemeral: { startedAt: number; promptChars?: number; outputChars?: number }): void;
}

export interface LlmUsageContext {
  tracker: UsageTracker;
  stage: LlmUsageStage;
}

export interface BackgroundJobHandle {
  usageContext: LlmUsageContext;
  /** 幂等：重复调用只生效一次，避免重复递减 pending */
  done(result?: { status: 'ok' | 'failed' }): void;
}

export interface RecordCallInput {
  stage: LlmUsageStage;
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  transportStatus: LlmCallUsage['transportStatus'];
  deliveryMode: LlmCallUsage['deliveryMode'];
  /** 供应商原始 usage；拿不到就传 null（记 missing，不用 0 冒充） */
  rawUsage: RawProviderUsage | null | undefined;
  latencyMs: number;
  errorKind?: LlmCallUsage['errorKind'];
  /** 只进观测、不进 usage 表 */
  ephemeral?: { promptChars?: number; outputChars?: number };
}

export interface CreateTrackerInput {
  projectId: string;
  conversationId?: string | null;
  parentTurnId?: string | null;
  pipeline: LlmPipeline;
  source: LlmRequestSource;
  observer?: LlmUsageObserver;
  log?: { warn(msg: string): void };
}

export class UsageTracker {
  readonly turnId: string;
  /** true = 建 turn 时存储故障，纯内存降级：不落库、不启依赖持久化的后台任务 */
  readonly degraded: boolean;

  private readonly stageCounters = new Map<LlmUsageStage, number>();
  private readonly log?: { warn(msg: string): void };
  private readonly observer?: LlmUsageObserver;
  private droppedInMemory = 0;
  private finished = false;
  /** degraded 模式下的内存汇总（仅供当前响应） */
  private readonly memoryCalls: LlmCallUsage[] = [];

  constructor(turnId: string, degraded: boolean, opts: { observer?: LlmUsageObserver; log?: { warn(msg: string): void } }) {
    this.turnId = turnId;
    this.degraded = degraded;
    this.observer = opts.observer;
    this.log = opts.log;
  }

  /** stage 内的调用序号由 tracker 统一分配，保证唯一索引不冲突 */
  private nextStageIndex(stage: LlmUsageStage): number {
    const next = this.stageCounters.get(stage) ?? 0;
    this.stageCounters.set(stage, next + 1);
    return next;
  }

  /**
   * 记录一次真实的供应商调用。**同步返回、不抛异常**——它跑在问答主链路上。
   */
  record(input: RecordCallInput): void {
    const startedAt = Date.now() - input.latencyMs;
    const normalized = normalizeProviderUsage(input.rawUsage);
    const pricing = resolvePricing(input.provider, input.model, input.baseUrl, this.log) ?? undefined;
    const cost = pricing && normalized.usageSource !== 'missing' ? computeCost(normalized.tokens, pricing) : undefined;

    // 序号只分配一次：id 与 stageCallIndex 必须来自同一个值，否则唯一索引与 id 会对不上
    const stageCallIndex = this.nextStageIndex(input.stage);
    const usage: LlmCallUsage = {
      id: `${this.turnId}:${input.stage}:${stageCallIndex}`,
      turnId: this.turnId,
      stage: input.stage,
      stageCallIndex,
      provider: input.provider,
      model: input.model,
      canonicalModel: canonicalizeModel(input.provider, input.model, input.baseUrl),
      transportStatus: input.transportStatus,
      usageSource: normalized.usageSource,
      deliveryMode: input.deliveryMode,
      validationWarnings: normalized.validationWarnings,
      tokens: normalized.tokens,
      pricing,
      cacheHitCostNanoCny: cost?.cacheHitCostNanoCny,
      cacheMissCostNanoCny: cost?.cacheMissCostNanoCny,
      outputCostNanoCny: cost?.outputCostNanoCny,
      totalCostNanoCny: cost?.totalCostNanoCny,
      latencyMs: input.latencyMs,
      errorKind: input.errorKind,
      createdAt: Date.now(),
    };

    // 观测出口先走：即使本地写库失败，Langfuse 也该拿到这次 usage
    try {
      this.observer?.onCallRecorded(usage, { startedAt, ...input.ephemeral });
    } catch {
      /* 观测失败不影响主链路 */
    }

    if (this.degraded) {
      this.memoryCalls.push(usage);
      return;
    }

    try {
      const result = recordUsageEvent(usage);
      if (!result.ok && result.reason === 'turn_not_found') {
        // 会话/项目已删：丢弃迟到事件，绝不重建 turn
        this.log?.warn(`[usage] turn ${this.turnId} 已不存在，丢弃 ${input.stage} 事件`);
      }
    } catch (err) {
      this.droppedInMemory += 1;
      this.log?.warn(`[usage] 记录调用失败（已计入 dropped）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 登记一个后台任务。必须在主链路 `finish()` **之前**调用，
   * 否则会出现"主链路已结算、后台任务随后才登记"的竞态。
   */
  registerBackground(stage: LlmUsageStage): BackgroundJobHandle {
    if (!this.degraded) {
      try {
        incrementPendingJobs(this.turnId, Date.now() + settlementTimeoutMs());
      } catch (err) {
        this.log?.warn(`[usage] 登记后台任务失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let done = false;
    return {
      usageContext: { tracker: this, stage },
      done: (result) => {
        if (done) return; // 幂等：重复 done 不重复递减
        done = true;
        if (this.degraded) return;
        try {
          finishBackgroundJob({ turnId: this.turnId, failed: result?.status === 'failed' });
        } catch (err) {
          this.log?.warn(`[usage] 后台任务结算失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }

  /**
   * 主链路终结（幂等）。所有出口——成功、异常、超时、早退、abort——都必须走到这里，
   * 否则 turn 会永远停在 collecting。
   */
  finish(executionStatus: Exclude<TurnExecutionStatus, 'running'>): TurnUsageSummary {
    if (!this.finished) {
      this.finished = true;
      this.flushDropped();
      if (!this.degraded) {
        try {
          const summary = interactiveDone(this.turnId, executionStatus);
          if (summary) return this.withMemoryFlags(summary);
        } catch (err) {
          this.log?.warn(`[usage] 终结 turn 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return this.summary(executionStatus);
  }

  /** 当前汇总（不改状态）。degraded 或读库失败时回落到内存汇总 */
  summary(executionStatus: TurnExecutionStatus = 'running'): TurnUsageSummary {
    if (!this.degraded) {
      try {
        const s = getTurnSummary(this.turnId);
        if (s) return this.withMemoryFlags(s);
      } catch {
        /* 落到内存汇总 */
      }
    }
    return this.memorySummary(executionStatus);
  }

  /** 把内存里的降级标志合并进数据库汇总——即使回写失败，响应也必须显示 partial */
  private withMemoryFlags(summary: TurnUsageSummary): TurnUsageSummary {
    if (this.droppedInMemory === 0) return summary;
    const reasons = new Set<TurnPartialReason>(summary.partialReasons);
    reasons.add('tracking_write_failed');
    return {
      ...summary,
      droppedUsageRecords: Math.max(summary.droppedUsageRecords, this.droppedInMemory),
      partial: true,
      partialReasons: [...reasons],
    };
  }

  /** best-effort 回写 dropped 计数；失败也只是继续用内存标志 */
  private flushDropped(): void {
    if (this.degraded || this.droppedInMemory === 0) return;
    try {
      addDroppedUsageRecords(this.turnId, this.droppedInMemory);
    } catch {
      /* 内存标志仍会让摘要显示 partial */
    }
  }

  private memorySummary(executionStatus: TurnExecutionStatus): TurnUsageSummary {
    const sum = (pick: (u: LlmCallUsage) => number | undefined): number =>
      this.memoryCalls.reduce((acc, u) => acc + (pick(u) ?? 0), 0);
    const reasons: TurnPartialReason[] = ['tracking_write_failed'];
    if (this.memoryCalls.some((u) => u.usageSource === 'missing')) reasons.push('usage_missing');
    if (this.memoryCalls.some((u) => u.usageSource !== 'missing' && u.totalCostNanoCny === undefined)) {
      reasons.push('pricing_unknown');
    }
    const hit = sum((u) => u.tokens.cacheHitTokens);
    const miss = sum((u) => u.tokens.cacheMissTokens);
    return {
      turnId: this.turnId,
      executionStatus,
      settlementStatus: 'settled',
      settled: true,
      partial: true,
      partialReasons: reasons,
      callCount: this.memoryCalls.length,
      successCallCount: this.memoryCalls.filter((u) => u.transportStatus === 'success').length,
      errorCallCount: this.memoryCalls.filter((u) => u.transportStatus === 'error').length,
      abortedCallCount: this.memoryCalls.filter((u) => u.transportStatus === 'aborted').length,
      usageMissingCalls: this.memoryCalls.filter((u) => u.usageSource === 'missing').length,
      usageWarningCalls: this.memoryCalls.filter((u) => u.validationWarnings.length > 0).length,
      unknownPricingCalls: this.memoryCalls.filter(
        (u) => u.usageSource !== 'missing' && u.totalCostNanoCny === undefined,
      ).length,
      droppedUsageRecords: this.droppedInMemory,
      lateDroppedEvents: 0,
      backgroundFailedJobs: 0,
      backgroundTimedOutJobs: 0,
      promptTokens: sum((u) => u.tokens.promptTokens),
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      completionTokens: sum((u) => u.tokens.completionTokens),
      reasoningTokens: sum((u) => u.tokens.reasoningTokens),
      totalTokens: sum((u) => u.tokens.totalTokens),
      cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : undefined,
      knownCostNanoCny: sum((u) => u.totalCostNanoCny),
      updatedAt: Date.now(),
    };
  }
}

/**
 * 建 tracker。存储故障时一次短重试，仍失败则 fail-open 为纯内存 degraded tracker——
 * 观测坏了不能拦着用户提问。
 */
export function createUsageTracker(input: CreateTrackerInput): UsageTracker {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const turnId = createUsageTurn({
        projectId: input.projectId,
        conversationId: input.conversationId,
        parentTurnId: input.parentTurnId,
        pipeline: input.pipeline,
        source: input.source,
      });
      return new UsageTracker(turnId, false, { observer: input.observer, log: input.log });
    } catch (err) {
      if (attempt === 1) {
        input.log?.warn(
          `[usage] 创建 turn 失败，降级为纯内存追踪（本轮刷新后不可恢复）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  // degraded turnId 只在当前响应内有意义，usage endpoint 会 404
  return new UsageTracker(`degraded-${Date.now()}-${Math.round(Math.random() * 1e6)}`, true, {
    observer: input.observer,
    log: input.log,
  });
}

/** 供 adapter 使用的便捷入口：usageContext 可选，没有就完全不记（例如离线单测） */
export function recordViaContext(ctx: LlmUsageContext | undefined, input: Omit<RecordCallInput, 'stage'>): void {
  if (!ctx) return;
  ctx.tracker.record({ ...input, stage: ctx.stage });
}
