/**
 * 成本追踪的存储层（阶段 2）——turn 生命周期 + event 事实 + 结算/恢复/清扫。
 *
 * 边界（改动前请读设计文档 §10）：
 *   - 本模块只做 SQLite 读写，不碰 LLM、不做归属判断；内存态与 stage 分配在 UsageTracker。
 *   - 写入一律 best-effort：调用方捕获异常并降级，**绝不让成本追踪把问答搞挂**。
 *   - 三个"不完整"计数语义互不重叠（见 v6 迁移注释），不得合并。
 *   - 进 settled 前从 events 重算覆盖汇总：增量更新可能因并发/丢写漂移，重算是最终一致性兜底。
 */
import crypto from 'node:crypto';
import type {
  LlmCallUsage,
  LlmPipeline,
  LlmRequestSource,
  LlmUsageStage,
  TurnExecutionStatus,
  TurnPartialReason,
  TurnSettlementStatus,
  TurnUsageSummary,
} from '@aiops/shared-types';
import { getDb } from './sqlite.js';

// ============================================================
// 行类型
// ============================================================

interface TurnRow {
  turn_id: string;
  project_id: string;
  conversation_id: string | null;
  assistant_message_id: string | null;
  parent_turn_id: string | null;
  pipeline: string;
  source: string;
  execution_status: string;
  settlement_status: string;
  pending_jobs: number;
  pending_deadline_at: number | null;
  call_count: number;
  success_call_count: number;
  error_call_count: number;
  aborted_call_count: number;
  usage_missing_calls: number;
  usage_warning_calls: number;
  unknown_pricing_calls: number;
  dropped_usage_records: number;
  late_dropped_events: number;
  background_failed_jobs: number;
  background_timed_out_jobs: number;
  partial_reasons_json: string;
  prompt_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  known_cost_nano_cny: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

export interface CreateTurnInput {
  projectId: string;
  conversationId?: string | null;
  parentTurnId?: string | null;
  pipeline: LlmPipeline;
  source: LlmRequestSource;
}

/** 记录一次调用所需的全部字段（tracker 组装好后交给本层落库） */
export type RecordEventInput = Omit<LlmCallUsage, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

export type RecordEventResult =
  | { ok: true }
  /** turn 不存在（会话/项目已删）→ 丢弃，绝不重建 turn */
  | { ok: false; reason: 'turn_not_found' }
  /** turn 已结算（watchdog 超时或已 settled）→ 记 late_dropped_events，不复活 turn */
  | { ok: false; reason: 'turn_settled' }
  /** 唯一索引冲突：同一 (turn, stage, index) 重复写入 → 幂等丢弃，不重复计费 */
  | { ok: false; reason: 'duplicate' };

// ============================================================
// 建 turn
// ============================================================

export function createUsageTurn(input: CreateTurnInput): string {
  const db = getDb();
  const turnId = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO llm_usage_turns
       (turn_id, project_id, conversation_id, parent_turn_id, pipeline, source,
        execution_status, settlement_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 'collecting', ?, ?)`,
  ).run(
    turnId,
    input.projectId,
    input.conversationId ?? null,
    input.parentTurnId ?? null,
    input.pipeline,
    input.source,
    now,
    now,
  );
  return turnId;
}

export function setAssistantMessageId(turnId: string, messageId: string): void {
  getDb()
    .prepare(`UPDATE llm_usage_turns SET assistant_message_id = ?, updated_at = ? WHERE turn_id = ?`)
    .run(messageId, Date.now(), turnId);
}

// ============================================================
// 记录一次调用
// ============================================================

/**
 * 同一事务内：校验 turn 存在且未结算 → 插 event → 增量更新汇总。
 * 增量更新只是"当下能看的数"，最终以 settle 前的重算为准。
 */
export function recordUsageEvent(input: RecordEventInput): RecordEventResult {
  const db = getDb();
  const now = input.createdAt ?? Date.now();
  const id = input.id ?? crypto.randomUUID();

  const tx = db.transaction((): RecordEventResult => {
    const turn = db
      .prepare(`SELECT settlement_status FROM llm_usage_turns WHERE turn_id = ?`)
      .get(input.turnId) as { settlement_status: string } | undefined;
    if (!turn) return { ok: false, reason: 'turn_not_found' };
    if (turn.settlement_status === 'settled') {
      // 迟到被拒：只累加计数与 partial reason，不改 settled_at、不复活 turn
      db.prepare(
        `UPDATE llm_usage_turns SET late_dropped_events = late_dropped_events + 1, updated_at = ?
          WHERE turn_id = ?`,
      ).run(now, input.turnId);
      addPartialReasonInTx(input.turnId, 'late_event_dropped');
      return { ok: false, reason: 'turn_settled' };
    }

    try {
      db.prepare(
        `INSERT INTO llm_usage_events
           (id, turn_id, stage, stage_call_index, provider, model, canonical_model,
            transport_status, usage_source, delivery_mode, validation_warnings_json,
            prompt_tokens, cache_hit_tokens, cache_miss_tokens, completion_tokens,
            reasoning_tokens, total_tokens, cache_hit_cost_nano_cny, cache_miss_cost_nano_cny,
            output_cost_nano_cny, total_cost_nano_cny, pricing_snapshot_json,
            latency_ms, error_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.turnId,
        input.stage,
        input.stageCallIndex,
        input.provider,
        input.model,
        input.canonicalModel,
        input.transportStatus,
        input.usageSource,
        input.deliveryMode,
        JSON.stringify(input.validationWarnings ?? []),
        input.tokens.promptTokens ?? null,
        input.tokens.cacheHitTokens ?? null,
        input.tokens.cacheMissTokens ?? null,
        input.tokens.completionTokens ?? null,
        input.tokens.reasoningTokens ?? null,
        input.tokens.totalTokens ?? null,
        input.cacheHitCostNanoCny ?? null,
        input.cacheMissCostNanoCny ?? null,
        input.outputCostNanoCny ?? null,
        input.totalCostNanoCny ?? null,
        input.pricing ? JSON.stringify(input.pricing) : null,
        input.latencyMs,
        input.errorKind ?? null,
        now,
      );
    } catch (err) {
      // 唯一索引冲突 = 同一次调用被重复记账，幂等丢弃
      if (String((err as { code?: string }).code ?? '').includes('CONSTRAINT')) {
        return { ok: false, reason: 'duplicate' };
      }
      throw err;
    }

    const warn = (input.validationWarnings ?? []).length > 0 ? 1 : 0;
    const missing = input.usageSource === 'missing' ? 1 : 0;
    const unknownPricing = input.usageSource !== 'missing' && input.totalCostNanoCny === undefined ? 1 : 0;

    db.prepare(
      `UPDATE llm_usage_turns SET
         call_count = call_count + 1,
         success_call_count = success_call_count + ?,
         error_call_count = error_call_count + ?,
         aborted_call_count = aborted_call_count + ?,
         usage_missing_calls = usage_missing_calls + ?,
         usage_warning_calls = usage_warning_calls + ?,
         unknown_pricing_calls = unknown_pricing_calls + ?,
         prompt_tokens = prompt_tokens + ?,
         cache_hit_tokens = cache_hit_tokens + ?,
         cache_miss_tokens = cache_miss_tokens + ?,
         completion_tokens = completion_tokens + ?,
         reasoning_tokens = reasoning_tokens + ?,
         total_tokens = total_tokens + ?,
         known_cost_nano_cny = known_cost_nano_cny + ?,
         updated_at = ?
       WHERE turn_id = ?`,
    ).run(
      input.transportStatus === 'success' ? 1 : 0,
      input.transportStatus === 'error' ? 1 : 0,
      input.transportStatus === 'aborted' ? 1 : 0,
      missing,
      warn,
      unknownPricing,
      input.tokens.promptTokens ?? 0,
      input.tokens.cacheHitTokens ?? 0,
      input.tokens.cacheMissTokens ?? 0,
      input.tokens.completionTokens ?? 0,
      input.tokens.reasoningTokens ?? 0,
      input.tokens.totalTokens ?? 0,
      input.totalCostNanoCny ?? 0,
      now,
      input.turnId,
    );

    if (missing) addPartialReasonInTx(input.turnId, 'usage_missing');
    if (unknownPricing) addPartialReasonInTx(input.turnId, 'pricing_unknown');
    if (warn) addPartialReasonInTx(input.turnId, 'provider_usage_inconsistent');

    return { ok: true };
  });

  return tx();
}

// ============================================================
// partial reasons（受控集合，去重）
// ============================================================

function addPartialReasonInTx(turnId: string, reason: TurnPartialReason): void {
  const db = getDb();
  const row = db.prepare(`SELECT partial_reasons_json FROM llm_usage_turns WHERE turn_id = ?`).get(turnId) as
    | { partial_reasons_json: string }
    | undefined;
  if (!row) return;
  let reasons: TurnPartialReason[] = [];
  try {
    reasons = JSON.parse(row.partial_reasons_json) as TurnPartialReason[];
  } catch {
    reasons = [];
  }
  if (reasons.includes(reason)) return;
  reasons.push(reason);
  db.prepare(`UPDATE llm_usage_turns SET partial_reasons_json = ? WHERE turn_id = ?`).run(
    JSON.stringify(reasons),
    turnId,
  );
}

export function addPartialReason(turnId: string, reason: TurnPartialReason): void {
  getDb().transaction(() => addPartialReasonInTx(turnId, reason))();
}

/** 追踪写失败：内存计数回写（幂等 best-effort，最终重算不得清零它） */
export function addDroppedUsageRecords(turnId: string, count: number): void {
  if (count <= 0) return;
  const db = getDb();
  db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE llm_usage_turns SET dropped_usage_records = dropped_usage_records + ?, updated_at = ?
          WHERE turn_id = ?`,
      )
      .run(count, Date.now(), turnId).changes;
    if (changed > 0) addPartialReasonInTx(turnId, 'tracking_write_failed');
  })();
}

// ============================================================
// 后台任务计数与结算
// ============================================================

export function incrementPendingJobs(turnId: string, deadlineAt: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE llm_usage_turns
        SET pending_jobs = pending_jobs + 1,
            pending_deadline_at = COALESCE(pending_deadline_at, ?),
            updated_at = ?
      WHERE turn_id = ? AND settlement_status != 'settled'`,
  ).run(deadlineAt, Date.now(), turnId);
}

export interface JobDoneInput {
  turnId: string;
  failed?: boolean;
}

/**
 * 后台任务结束：原子递减 pending、累计失败数，并在归零时尝试结算。
 * 返回结算后的 summary（未结算则返回当前 summary）。
 */
export function finishBackgroundJob(input: JobDoneInput): TurnUsageSummary | null {
  const db = getDb();
  const tx = db.transaction((): TurnUsageSummary | null => {
    const row = db.prepare(`SELECT * FROM llm_usage_turns WHERE turn_id = ?`).get(input.turnId) as
      | TurnRow
      | undefined;
    if (!row) return null;
    // 已被 watchdog 结算：句柄过期，迟到的 done() 幂等 no-op
    if (row.settlement_status === 'settled') return rowToSummary(row);

    const pending = Math.max(0, row.pending_jobs - 1);
    db.prepare(
      `UPDATE llm_usage_turns SET pending_jobs = ?, background_failed_jobs = background_failed_jobs + ?,
         updated_at = ? WHERE turn_id = ?`,
    ).run(pending, input.failed ? 1 : 0, Date.now(), input.turnId);
    if (input.failed) addPartialReasonInTx(input.turnId, 'background_failed');

    if (pending === 0 && row.settlement_status === 'pending') {
      return settleInTx(input.turnId);
    }
    return getSummaryInTx(input.turnId);
  });
  return tx();
}

/**
 * 主链路终结。pendingJobs=0 直接 settled，否则转 pending。
 * 幂等：已经不是 collecting 时不再迁移状态，只返回当前 summary。
 */
export function interactiveDone(
  turnId: string,
  executionStatus: Exclude<TurnExecutionStatus, 'running'>,
): TurnUsageSummary | null {
  const db = getDb();
  const tx = db.transaction((): TurnUsageSummary | null => {
    const row = db.prepare(`SELECT * FROM llm_usage_turns WHERE turn_id = ?`).get(turnId) as TurnRow | undefined;
    if (!row) return null;
    if (row.settlement_status !== 'collecting') return rowToSummary(row);

    db.prepare(`UPDATE llm_usage_turns SET execution_status = ?, updated_at = ? WHERE turn_id = ?`).run(
      executionStatus,
      Date.now(),
      turnId,
    );

    if (row.pending_jobs > 0) {
      db.prepare(`UPDATE llm_usage_turns SET settlement_status = 'pending' WHERE turn_id = ?`).run(turnId);
      return getSummaryInTx(turnId);
    }
    return settleInTx(turnId);
  });
  return tx();
}

/**
 * 结算：先从 events 重算覆盖汇总，再置 settled。二者必须同事务，
 * 否则会出现"已 settled 但汇总还是旧值"的中间态。
 */
function settleInTx(turnId: string, extraReason?: TurnPartialReason): TurnUsageSummary | null {
  const db = getDb();
  recomputeFromEventsInTx(turnId);
  if (extraReason) addPartialReasonInTx(turnId, extraReason);
  const now = Date.now();
  db.prepare(
    `UPDATE llm_usage_turns
        SET settlement_status = 'settled', pending_jobs = 0, pending_deadline_at = NULL,
            settled_at = ?, updated_at = ?
      WHERE turn_id = ?`,
  ).run(now, now, turnId);
  return getSummaryInTx(turnId);
}

/**
 * 从 events 重算可派生字段。
 * 注意：dropped_usage_records / late_dropped_events / background_* 不可从 events 派生，
 * 必须原样保留——它们记录的正是"没能进 events 的那部分"。
 */
function recomputeFromEventsInTx(turnId: string): void {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT
         COUNT(*)                                                              AS call_count,
         SUM(CASE WHEN transport_status = 'success' THEN 1 ELSE 0 END)         AS success_call_count,
         SUM(CASE WHEN transport_status = 'error' THEN 1 ELSE 0 END)           AS error_call_count,
         SUM(CASE WHEN transport_status = 'aborted' THEN 1 ELSE 0 END)         AS aborted_call_count,
         SUM(CASE WHEN usage_source = 'missing' THEN 1 ELSE 0 END)             AS usage_missing_calls,
         SUM(CASE WHEN validation_warnings_json != '[]' THEN 1 ELSE 0 END)     AS usage_warning_calls,
         SUM(CASE WHEN usage_source != 'missing' AND total_cost_nano_cny IS NULL THEN 1 ELSE 0 END)
                                                                               AS unknown_pricing_calls,
         SUM(COALESCE(prompt_tokens, 0))       AS prompt_tokens,
         SUM(COALESCE(cache_hit_tokens, 0))    AS cache_hit_tokens,
         SUM(COALESCE(cache_miss_tokens, 0))   AS cache_miss_tokens,
         SUM(COALESCE(completion_tokens, 0))   AS completion_tokens,
         SUM(COALESCE(reasoning_tokens, 0))    AS reasoning_tokens,
         SUM(COALESCE(total_tokens, 0))        AS total_tokens,
         SUM(COALESCE(total_cost_nano_cny, 0)) AS known_cost_nano_cny
       FROM llm_usage_events WHERE turn_id = ?`,
    )
    .get(turnId) as Record<string, number | null>;

  const n = (k: string): number => agg[k] ?? 0;
  db.prepare(
    `UPDATE llm_usage_turns SET
       call_count = ?, success_call_count = ?, error_call_count = ?, aborted_call_count = ?,
       usage_missing_calls = ?, usage_warning_calls = ?, unknown_pricing_calls = ?,
       prompt_tokens = ?, cache_hit_tokens = ?, cache_miss_tokens = ?, completion_tokens = ?,
       reasoning_tokens = ?, total_tokens = ?, known_cost_nano_cny = ?, updated_at = ?
     WHERE turn_id = ?`,
  ).run(
    n('call_count'), n('success_call_count'), n('error_call_count'), n('aborted_call_count'),
    n('usage_missing_calls'), n('usage_warning_calls'), n('unknown_pricing_calls'),
    n('prompt_tokens'), n('cache_hit_tokens'), n('cache_miss_tokens'), n('completion_tokens'),
    n('reasoning_tokens'), n('total_tokens'), n('known_cost_nano_cny'), Date.now(), turnId,
  );
}

// ============================================================
// watchdog / 启动恢复 / 孤儿清扫
// ============================================================

/**
 * 结算超时看门狗：长跑进程不能靠重启解卡。
 * 把超过 deadline 仍 pending 的 turn 强制结算，未完成的 job 计入 background_timed_out_jobs。
 */
export function settleTimedOutTurns(now = Date.now()): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT turn_id, pending_jobs FROM llm_usage_turns
        WHERE settlement_status = 'pending' AND pending_deadline_at IS NOT NULL AND pending_deadline_at <= ?`,
    )
    .all(now) as Array<{ turn_id: string; pending_jobs: number }>;

  const settled: string[] = [];
  for (const row of rows) {
    db.transaction(() => {
      db.prepare(
        `UPDATE llm_usage_turns SET background_timed_out_jobs = background_timed_out_jobs + ? WHERE turn_id = ?`,
      ).run(Math.max(0, row.pending_jobs), row.turn_id);
      settleInTx(row.turn_id, 'settlement_timeout');
    })();
    settled.push(row.turn_id);
  }
  return settled;
}

/**
 * 启动恢复：上个进程残留的 running / collecting / pending 一次性收口，
 * 避免 turn 永久显示"结算中"。
 */
export function recoverInterruptedTurns(): number {
  const db = getDb();
  const rows = db
    .prepare(`SELECT turn_id, execution_status FROM llm_usage_turns WHERE settlement_status IN ('collecting','pending')`)
    .all() as Array<{ turn_id: string; execution_status: string }>;

  for (const row of rows) {
    db.transaction(() => {
      // aborted 是用户意图，保持不变；running 属于"进程死了"，改 failed
      if (row.execution_status === 'running') {
        db.prepare(`UPDATE llm_usage_turns SET execution_status = 'failed' WHERE turn_id = ?`).run(row.turn_id);
      }
      settleInTx(row.turn_id, 'process_interrupted');
    })();
  }
  return rows.length;
}

/**
 * 孤儿清扫：删除不属于任何有效项目的 usage 行。
 * 有效集合为空时走全删分支——拼 `NOT IN ()` 是非法 SQL。
 */
export function sweepOrphanUsage(validProjectIds: string[]): number {
  const db = getDb();
  return db.transaction(() => {
    if (validProjectIds.length === 0) {
      const events = db.prepare(`DELETE FROM llm_usage_events`).run().changes;
      db.prepare(`DELETE FROM llm_usage_turns`).run();
      return events;
    }
    const placeholders = validProjectIds.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM llm_usage_events WHERE turn_id IN
         (SELECT turn_id FROM llm_usage_turns WHERE project_id NOT IN (${placeholders}))`,
    ).run(...validProjectIds);
    return db
      .prepare(`DELETE FROM llm_usage_turns WHERE project_id NOT IN (${placeholders})`)
      .run(...validProjectIds).changes;
  })();
}

export function deleteUsageByConversation(conversationId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM llm_usage_events WHERE turn_id IN
         (SELECT turn_id FROM llm_usage_turns WHERE conversation_id = ?)`,
    ).run(conversationId);
    db.prepare(`DELETE FROM llm_usage_turns WHERE conversation_id = ?`).run(conversationId);
  })();
}

export function deleteUsageByProject(projectId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM llm_usage_events WHERE turn_id IN
         (SELECT turn_id FROM llm_usage_turns WHERE project_id = ?)`,
    ).run(projectId);
    db.prepare(`DELETE FROM llm_usage_turns WHERE project_id = ?`).run(projectId);
  })();
}

// ============================================================
// 读取
// ============================================================

function rowToSummary(row: TurnRow): TurnUsageSummary {
  let partialReasons: TurnPartialReason[] = [];
  try {
    partialReasons = JSON.parse(row.partial_reasons_json) as TurnPartialReason[];
  } catch {
    partialReasons = [];
  }
  const inputTokens = row.cache_hit_tokens + row.cache_miss_tokens;
  return {
    turnId: row.turn_id,
    executionStatus: row.execution_status as TurnExecutionStatus,
    settlementStatus: row.settlement_status as TurnSettlementStatus,
    settled: row.settlement_status === 'settled',
    partial: partialReasons.length > 0,
    partialReasons,
    callCount: row.call_count,
    successCallCount: row.success_call_count,
    errorCallCount: row.error_call_count,
    abortedCallCount: row.aborted_call_count,
    usageMissingCalls: row.usage_missing_calls,
    usageWarningCalls: row.usage_warning_calls,
    unknownPricingCalls: row.unknown_pricing_calls,
    droppedUsageRecords: row.dropped_usage_records,
    lateDroppedEvents: row.late_dropped_events,
    backgroundFailedJobs: row.background_failed_jobs,
    backgroundTimedOutJobs: row.background_timed_out_jobs,
    promptTokens: row.prompt_tokens,
    cacheHitTokens: row.cache_hit_tokens,
    cacheMissTokens: row.cache_miss_tokens,
    completionTokens: row.completion_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    // 命中率只在有输入时给；"是否同一支持缓存的模型"由上层按 events 判定后覆盖
    cacheHitRate: inputTokens > 0 ? row.cache_hit_tokens / inputTokens : undefined,
    knownCostNanoCny: row.known_cost_nano_cny,
    updatedAt: row.updated_at,
  };
}

function getSummaryInTx(turnId: string): TurnUsageSummary | null {
  const row = getDb().prepare(`SELECT * FROM llm_usage_turns WHERE turn_id = ?`).get(turnId) as TurnRow | undefined;
  return row ? rowToSummary(row) : null;
}

export function getTurnSummary(turnId: string): TurnUsageSummary | null {
  return getSummaryInTx(turnId);
}

export function getTurnProjectId(turnId: string): string | null {
  const row = getDb().prepare(`SELECT project_id FROM llm_usage_turns WHERE turn_id = ?`).get(turnId) as
    | { project_id: string }
    | undefined;
  return row?.project_id ?? null;
}

export function getTurnEvents(turnId: string): LlmCallUsage[] {
  const rows = getDb()
    .prepare(`SELECT * FROM llm_usage_events WHERE turn_id = ? ORDER BY created_at, stage_call_index`)
    .all(turnId) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const opt = (k: string): number | undefined => (r[k] === null || r[k] === undefined ? undefined : Number(r[k]));
    return {
      id: String(r.id),
      turnId: String(r.turn_id),
      stage: String(r.stage) as LlmUsageStage,
      stageCallIndex: Number(r.stage_call_index),
      provider: String(r.provider) as LlmCallUsage['provider'],
      model: String(r.model),
      canonicalModel: String(r.canonical_model),
      transportStatus: String(r.transport_status) as LlmCallUsage['transportStatus'],
      usageSource: String(r.usage_source) as LlmCallUsage['usageSource'],
      deliveryMode: String(r.delivery_mode) as LlmCallUsage['deliveryMode'],
      validationWarnings: JSON.parse(String(r.validation_warnings_json ?? '[]')),
      tokens: {
        promptTokens: opt('prompt_tokens'),
        cacheHitTokens: opt('cache_hit_tokens'),
        cacheMissTokens: opt('cache_miss_tokens'),
        completionTokens: opt('completion_tokens'),
        reasoningTokens: opt('reasoning_tokens'),
        totalTokens: opt('total_tokens'),
      },
      pricing: r.pricing_snapshot_json ? JSON.parse(String(r.pricing_snapshot_json)) : undefined,
      cacheHitCostNanoCny: opt('cache_hit_cost_nano_cny'),
      cacheMissCostNanoCny: opt('cache_miss_cost_nano_cny'),
      outputCostNanoCny: opt('output_cost_nano_cny'),
      totalCostNanoCny: opt('total_cost_nano_cny'),
      latencyMs: Number(r.latency_ms),
      errorKind: (r.error_kind ?? undefined) as LlmCallUsage['errorKind'],
      createdAt: Number(r.created_at),
    };
  });
}
