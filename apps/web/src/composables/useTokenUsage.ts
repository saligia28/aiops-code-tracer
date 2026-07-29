/**
 * 本轮 Token 成本（设计文档 §13.2）——取明细 + 轮询结算。
 *
 * 职责边界：只管数据获取与轮询，渲染交给 TokenUsagePanel。
 * 两条纪律：
 *   - 同一 turn 不允许存在两个 poller（重复轮询既费请求也会互相覆盖状态）；
 *   - 轮询失败**不覆盖**已有的初步汇总——宁可显示旧数据，也不能把用户已经看到的成本抹成空白。
 */
import { ref } from 'vue'
import http from '@/lib/http'

// 后端契约（来自 @aiops/shared-types；web 未接该别名，就地写最小结构以能 typecheck）
export interface TurnUsageSummary {
  turnId: string
  executionStatus: 'running' | 'completed' | 'failed' | 'aborted'
  settlementStatus: 'collecting' | 'pending' | 'settled'
  settled: boolean
  partial: boolean
  partialReasons: string[]
  callCount: number
  usageMissingCalls: number
  unknownPricingCalls: number
  droppedUsageRecords: number
  lateDroppedEvents: number
  backgroundFailedJobs: number
  backgroundTimedOutJobs: number
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate?: number
  knownCostNanoCny: number
  updatedAt: number
}

export interface TokenUsageEvent {
  id: string
  stage: string
  stageCallIndex: number
  model: string
  canonicalModel: string
  transportStatus: 'success' | 'error' | 'aborted'
  usageSource: 'provider' | 'estimated' | 'missing'
  deliveryMode: 'stream' | 'non_stream'
  tokens: {
    promptTokens?: number
    cacheHitTokens?: number
    cacheMissTokens?: number
    completionTokens?: number
    reasoningTokens?: number
    totalTokens?: number
  }
  pricing?: { matchKind: 'exact_model' | 'official_alias' | 'custom_override'; supportsPromptCache: boolean }
  totalCostNanoCny?: number
  latencyMs: number
  errorKind?: string
}

/** 轮询间隔与上限：结算通常在秒级完成，30 秒还没好就停下来让用户手动刷新 */
const POLL_INTERVAL_MS = 1500
const POLL_MAX_MS = 30_000

export function useTokenUsage() {
  const events = ref<Record<string, TokenUsageEvent[]>>({})
  const loading = ref<Record<string, boolean>>({})
  /** turnId → timer，保证同一 turn 只有一个 poller */
  const pollers = new Map<string, ReturnType<typeof setInterval>>()

  async function fetchDetail(turnId: string): Promise<TurnUsageSummary | null> {
    loading.value = { ...loading.value, [turnId]: true }
    try {
      const { data } = await http.get(`/api/usage/turns/${turnId}`)
      events.value = { ...events.value, [turnId]: data.events ?? [] }
      return data.summary as TurnUsageSummary
    } catch {
      // 404 = degraded 追踪未持久化，或会话已删；保留现有数据不动
      return null
    } finally {
      loading.value = { ...loading.value, [turnId]: false }
    }
  }

  /**
   * 结算轮询。onUpdate 只在拿到新汇总时调用——失败时不回调，
   * 免得把已经显示的成本覆盖成空。
   */
  function startPolling(turnId: string, onUpdate: (s: TurnUsageSummary) => void): void {
    if (pollers.has(turnId)) return
    const startedAt = Date.now()
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stopPolling(turnId)
        return
      }
      const summary = await fetchDetail(turnId)
      if (!summary) return
      onUpdate(summary)
      if (summary.settled) stopPolling(turnId)
    }, POLL_INTERVAL_MS)
    pollers.set(turnId, timer)
  }

  function stopPolling(turnId: string): void {
    const timer = pollers.get(turnId)
    if (!timer) return
    clearInterval(timer)
    pollers.delete(turnId)
  }

  /** 组件卸载/离开页面时调用，避免后台空转 */
  function stopAll(): void {
    for (const timer of pollers.values()) clearInterval(timer)
    pollers.clear()
  }

  return { events, loading, fetchDetail, startPolling, stopPolling, stopAll }
}

// ============================================================
// 格式化（与服务端 services/usage/format.ts 同口径）
// ============================================================

const NANO_PER_CNY = 1_000_000_000

function stripZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/**
 * 摘要金额。**任何正成本都不能显示成 ¥0**——1 个缓存命中 token = 20 nano = 第 8 位小数，
 * 直接按 6 位截断会让用户以为这次没花钱。
 */
export function formatNanoCny(nanoCny: number): string {
  if (!Number.isFinite(nanoCny) || nanoCny <= 0) return '¥0'
  if (nanoCny < 1000) return '<¥0.000001'
  return `¥${stripZeros((nanoCny / NANO_PER_CNY).toFixed(6))}`
}

/** 明细金额：9 位小数，供人工按官方单价复算 */
export function formatNanoCnyPrecise(nanoCny: number): string {
  if (!Number.isFinite(nanoCny) || nanoCny <= 0) return '¥0'
  return `¥${stripZeros((nanoCny / NANO_PER_CNY).toFixed(9))}`
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  if (count < 1000) return String(Math.round(count))
  return `${stripZeros((count / 1000).toFixed(1))}k`
}

export function formatCacheHitRate(rate: number): string {
  return `${stripZeros((rate * 100).toFixed(1))}%`
}

/** partial 原因 → 人话。UI 不能只显示一个感叹号让用户猜 */
export const PARTIAL_REASON_TEXT: Record<string, string> = {
  usage_missing: '有调用未返回用量数据',
  pricing_unknown: '有模型未配置单价',
  provider_usage_inconsistent: '供应商返回的用量字段自相矛盾',
  tracking_write_failed: '追踪写入失败，以下为已记录部分',
  background_failed: '后台任务失败',
  settlement_timeout: '后台任务超时，已强制结算',
  late_event_dropped: '有调用在结算后才返回，未计入',
  process_interrupted: '服务重启，本轮成本为中断前的部分',
}

/**
 * 是否可以展示总缓存命中率。
 * 混合模型（比如同轮既用了 DeepSeek 又用了本地 Ollama）算出来的总命中率会被稀释成
 * 一个没有意义的数——Ollama 全记未命中，只因为它根本没有 prompt 缓存这回事。
 */
export function canShowCacheHitRate(events: TokenUsageEvent[] | undefined): boolean {
  if (!events || events.length === 0) return false
  const counted = events.filter((e) => e.usageSource !== 'missing')
  if (counted.length === 0) return false
  const models = new Set(counted.map((e) => e.canonicalModel))
  if (models.size > 1) return false
  return counted.every((e) => e.pricing?.supportsPromptCache === true)
}
