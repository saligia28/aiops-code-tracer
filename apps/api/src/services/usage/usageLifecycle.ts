/**
 * 成本追踪的进程级生命周期钩子（阶段 2）：启动恢复 + 孤儿清扫 + 结算看门狗。
 *
 * 三件事解决三个"永远查不清"的问题：
 *   - 启动恢复：上个进程死掉时留下的 collecting/pending，不恢复就永远显示"结算中"；
 *   - 孤儿清扫：项目删除后极端竞态留下的行，本身无害但会让成本统计口径慢慢变脏；
 *   - 看门狗：长跑进程不会天天重启，一个忘了 finally 的后台任务能把 turn 永久钉在 pending。
 *
 * 全部 best-effort：任何一步失败只记日志，绝不影响 API 启动或问答。
 */
import type { FastifyBaseLogger } from 'fastify';
import { recoverInterruptedTurns, settleTimedOutTurns, sweepOrphanUsage } from '../../db/usageStore.js';
import { readProjectRegistry } from '../projectService.js';
import { currentRepoName, resolveActiveProjectId } from '../../context.js';
import { settlementTimeoutMs } from './usageTracker.js';

/** 看门狗扫描间隔：比默认 10 分钟超时密一个量级即可，代价只是一次索引查询 */
const WATCHDOG_INTERVAL_MS = 60_000;

let watchdogTimer: NodeJS.Timeout | null = null;

/**
 * 有效项目集合 = 注册表里的项目 + 当前 legacy 回退 id。
 *
 * 必须在 current repo 解析完成之后调用：`resolveActiveProjectId()` 会回退到
 * `currentRepoName ?? 'default'`，提前清扫会把这些未注册但合法的项目误删。
 */
function validProjectIds(): string[] {
  const ids = new Set<string>();
  try {
    for (const p of readProjectRegistry()) ids.add(p.id);
  } catch {
    /* 注册表读不到时下面的 legacy id 仍会保住当前项目 */
  }
  if (currentRepoName) ids.add(currentRepoName);
  ids.add(resolveActiveProjectId());
  return [...ids];
}

/**
 * 启动时调用一次。顺序有讲究：先恢复再清扫——
 * 反过来的话，属于已删项目的 turn 会先被恢复流程重算一遍，白做功。
 */
export function initUsageLifecycle(log?: FastifyBaseLogger): void {
  try {
    const recovered = recoverInterruptedTurns();
    if (recovered > 0) log?.info(`[usage] 启动恢复：${recovered} 个未结算 turn 已标记 process_interrupted 并结算`);
  } catch (err) {
    log?.warn(`[usage] 启动恢复失败：${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const swept = sweepOrphanUsage(validProjectIds());
    if (swept > 0) log?.info(`[usage] 孤儿清扫：删除 ${swept} 个不属于有效项目的 turn`);
  } catch (err) {
    log?.warn(`[usage] 孤儿清扫失败：${err instanceof Error ? err.message : String(err)}`);
  }

  startSettlementWatchdog(log);
}

/** 结算看门狗。重复调用只会保留一个定时器 */
export function startSettlementWatchdog(log?: FastifyBaseLogger): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try {
      const settled = settleTimedOutTurns();
      if (settled.length > 0) {
        log?.warn(
          `[usage] 结算超时（>${Math.round(settlementTimeoutMs() / 1000)}s）：${settled.length} 个 turn 强制结算为 partial`,
        );
      }
    } catch (err) {
      log?.warn(`[usage] 看门狗扫描失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, WATCHDOG_INTERVAL_MS);
  // 不要因为这个定时器把进程钉住（CLI/测试进程该退就退）
  watchdogTimer.unref?.();
}

export function stopSettlementWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}
