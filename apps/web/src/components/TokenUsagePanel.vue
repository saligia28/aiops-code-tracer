<template>
  <div class="token-usage">
    <!-- 摘要行：点击展开明细 -->
    <button class="usage-summary" type="button" @click="toggle">
      <span class="usage-metric">{{ formatTokens(summary.totalTokens) }} tokens</span>
      <span v-if="showHitRate" class="usage-sep">·</span>
      <span v-if="showHitRate" class="usage-metric">缓存 {{ formatCacheHitRate(summary.cacheHitRate!) }}</span>
      <span class="usage-sep">·</span>
      <span class="usage-metric">{{ callCountText }}</span>
      <span class="usage-sep">·</span>
      <span class="usage-cost" :class="{ 'is-partial': summary.partial }">{{ costText }}</span>

      <span v-if="!summary.settled" class="usage-settling">
        <span class="settling-dot" />成本结算中
      </span>
      <span v-if="summary.partial" class="usage-warn" title="成本不完整，展开查看原因">⚠</span>
      <span class="usage-caret">{{ expanded ? '▴' : '▾' }}</span>
    </button>

    <div v-if="expanded" class="usage-detail">
      <!-- 不完整原因：不能只给一个感叹号让用户猜 -->
      <ul v-if="summary.partial" class="usage-reasons">
        <li v-for="reason in summary.partialReasons" :key="reason">
          {{ PARTIAL_REASON_TEXT[reason] || reason }}
        </li>
        <li v-if="summary.lateDroppedEvents > 0">
          另有 {{ summary.lateDroppedEvents }} 次调用在结算后才返回，未计入本轮成本
        </li>
      </ul>

      <p v-if="loading && !events.length" class="usage-loading">加载明细…</p>
      <p v-else-if="!events.length" class="usage-loading">本轮追踪未持久化，刷新后不可恢复</p>

      <template v-else>
        <!-- 先按阶段聚合：一轮 agent 可能有几十次调用，直接铺开没法看 -->
        <table class="usage-table">
          <thead>
            <tr>
              <th>阶段</th>
              <th>次数</th>
              <th class="num">输入 hit/miss</th>
              <th class="num">输出</th>
              <th class="num">成本</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="group in stageGroups" :key="group.stage">
              <tr class="stage-row" @click="toggleStage(group.stage)">
                <td>
                  <span class="stage-caret">{{ openStages.has(group.stage) ? '▾' : '▸' }}</span>
                  {{ group.stage }}
                </td>
                <td>{{ group.count }}</td>
                <td class="num">{{ group.hit }} / {{ group.miss }}</td>
                <td class="num">{{ group.output }}</td>
                <td class="num">{{ formatNanoCny(group.cost) }}</td>
              </tr>
              <tr v-for="e in openStages.has(group.stage) ? group.events : []" :key="e.id" class="call-row">
                <td class="call-model">
                  #{{ e.stageCallIndex }} {{ e.model }}
                  <span v-if="e.pricing?.matchKind === 'official_alias'" class="badge" title="按官方旧模型名映射计价">兼容别名计价</span>
                  <span v-if="e.deliveryMode === 'stream'" class="badge badge-plain">流式</span>
                  <span v-if="e.stage.endsWith('_fallback')" class="badge badge-plain" title="流式失败后整包重试——这是真实的第二次调用，不是重复记录">
                    流式失败后重试
                  </span>
                </td>
                <td>
                  <span :class="statusClass(e)">{{ statusText(e) }}</span>
                </td>
                <td class="num">{{ e.tokens.cacheHitTokens ?? '—' }} / {{ e.tokens.cacheMissTokens ?? '—' }}</td>
                <td class="num">
                  {{ e.tokens.completionTokens ?? '—' }}
                  <span v-if="e.tokens.reasoningTokens" class="reasoning" title="reasoning 是 output 的子集，不重复计费">
                    (含推理 {{ e.tokens.reasoningTokens }})
                  </span>
                </td>
                <td class="num" :title="e.totalCostNanoCny ? formatNanoCnyPrecise(e.totalCostNanoCny) : '单价未配置'">
                  {{ e.totalCostNanoCny === undefined ? '单价未配置' : formatNanoCnyPrecise(e.totalCostNanoCny) }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 本轮成本面板（设计文档 §13.2）。只负责渲染，数据获取在 useTokenUsage。
 *
 * 三条显示纪律（都是"别骗用户"）：
 *   - 正成本永不显示 ¥0（小于展示精度时显示 <¥0.000001）；
 *   - 有未知/缺失时显示"部分成本"，不能当完整总价；
 *   - 混合模型时隐藏总缓存命中率（Ollama 没有缓存，混着算出来的数没有意义）。
 */
import { computed, ref } from 'vue'
import {
  formatNanoCny,
  formatNanoCnyPrecise,
  formatTokens,
  formatCacheHitRate,
  canShowCacheHitRate,
  PARTIAL_REASON_TEXT,
  type TokenUsageEvent,
  type TurnUsageSummary,
} from '../composables/useTokenUsage'

const props = defineProps<{
  summary: TurnUsageSummary
  events?: TokenUsageEvent[]
  loading?: boolean
}>()
const emit = defineEmits<{ (e: 'expand'): void }>()

const expanded = ref(false)
const openStages = ref(new Set<string>())
const events = computed(() => props.events ?? [])

function toggle(): void {
  expanded.value = !expanded.value
  if (expanded.value) emit('expand')
}
function toggleStage(stage: string): void {
  const next = new Set(openStages.value)
  next.has(stage) ? next.delete(stage) : next.add(stage)
  openStages.value = next
}

const showHitRate = computed(
  () => props.summary.cacheHitRate !== undefined && canShowCacheHitRate(props.events),
)

/** 写失败时不能把 dropped 混进精确分项，要分开说 */
const callCountText = computed(() => {
  const dropped = props.summary.droppedUsageRecords
  return dropped > 0
    ? `已记录 ${props.summary.callCount} 次，另有 ${dropped} 次未持久化`
    : `${props.summary.callCount} 次调用`
})

const costText = computed(() => {
  const money = formatNanoCny(props.summary.knownCostNanoCny)
  return props.summary.partial ? `部分成本 ${money}` : money
})

interface StageGroup {
  stage: string
  count: number
  hit: number
  miss: number
  output: number
  cost: number
  events: TokenUsageEvent[]
}

const stageGroups = computed<StageGroup[]>(() => {
  const map = new Map<string, StageGroup>()
  for (const e of events.value) {
    const g = map.get(e.stage) ?? { stage: e.stage, count: 0, hit: 0, miss: 0, output: 0, cost: 0, events: [] }
    g.count += 1
    g.hit += e.tokens.cacheHitTokens ?? 0
    g.miss += e.tokens.cacheMissTokens ?? 0
    g.output += e.tokens.completionTokens ?? 0
    g.cost += e.totalCostNanoCny ?? 0
    g.events.push(e)
    map.set(e.stage, g)
  }
  return [...map.values()]
})

function statusText(e: TokenUsageEvent): string {
  if (e.transportStatus === 'success') return e.usageSource === 'estimated' ? '估算' : '成功'
  if (e.transportStatus === 'aborted') return '已中止'
  return e.errorKind === 'stream_incomplete' ? '流式未完成' : '失败'
}
function statusClass(e: TokenUsageEvent): string {
  if (e.transportStatus === 'success') return e.usageSource === 'estimated' ? 'st-warn' : 'st-ok'
  return 'st-err'
}
</script>

<style scoped>
.token-usage {
  margin-top: 8px;
  font-size: 12px;
}
.usage-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
}
.usage-summary:hover {
  border-color: var(--accent, #2563eb);
  color: var(--text-primary, #111827);
}
.usage-sep { opacity: 0.4; }
.usage-cost { font-variant-numeric: tabular-nums; }
.usage-cost.is-partial { color: var(--warning, #b45309); }
.usage-warn { color: var(--warning, #b45309); }
.usage-caret { opacity: 0.5; }

.usage-settling { display: inline-flex; align-items: center; gap: 4px; }
.settling-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent, #2563eb);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

.usage-detail {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle, #e5e7eb);
  border-radius: 8px;
  background: var(--surface-subtle, #f9fafb);
}
.usage-reasons {
  margin: 0 0 8px;
  padding-left: 18px;
  color: var(--warning, #b45309);
}
.usage-loading { margin: 0; color: var(--text-secondary, #6b7280); }

.usage-table { width: 100%; border-collapse: collapse; }
.usage-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-secondary, #6b7280);
  padding: 4px 6px;
  border-bottom: 1px solid var(--border-subtle, #e5e7eb);
}
.usage-table td { padding: 4px 6px; }
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.stage-row { cursor: pointer; }
.stage-row:hover { background: var(--surface-hover, rgba(0, 0, 0, 0.03)); }
.stage-caret { display: inline-block; width: 12px; opacity: 0.6; }
.call-row { color: var(--text-secondary, #6b7280); }
.call-model { padding-left: 18px !important; }
.reasoning { opacity: 0.7; }

.badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--warning-bg, #fef3c7);
  color: var(--warning, #b45309);
  font-size: 11px;
}
.badge-plain { background: var(--surface-hover, rgba(0, 0, 0, 0.05)); color: inherit; }
.st-ok { color: var(--success, #059669); }
.st-warn { color: var(--warning, #b45309); }
.st-err { color: var(--danger, #dc2626); }
</style>
