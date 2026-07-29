/**
 * 成本/Token 的显示格式化（成本追踪 · 阶段 1）。
 *
 * 核心规则（设计文档 §9.2）：**任何正成本都不能被格式化成 `¥0`**。
 * 1 个缓存命中 token = 20 nano-CNY = 0.00000002 元，是第 8 位小数；
 * 直接按 6 位小数截断就会显示成 `¥0`，等于对用户说"这次没花钱"。
 */

const NANO_PER_CNY = 1_000_000_000;
/** 6 位小数能表示的最小正数对应的 nano 值：0.000001 CNY = 1000 nano */
const MIN_DISPLAYABLE_NANO = 1000;

/** 去掉小数尾零；整数则不留小数点 */
function stripTrailingZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * 摘要行金额。三条互斥分支：
 *   0            → `¥0`
 *   0 < n < 1000 → `<¥0.000001`（有花费但小于展示精度，绝不写成 ¥0）
 *   其他          → 最多 6 位小数并去尾零
 */
export function formatNanoCny(nanoCny: number): string {
  if (!Number.isFinite(nanoCny) || nanoCny <= 0) return '¥0';
  if (nanoCny < MIN_DISPLAYABLE_NANO) return '<¥0.000001';
  return `¥${stripTrailingZeros((nanoCny / NANO_PER_CNY).toFixed(6))}`;
}

/**
 * 明细/tooltip 金额：最多 9 位小数，保证 nano-CNY 可被人工复算。
 * 这里不做 `<¥...` 降级——展开区就是给人核数的地方。
 */
export function formatNanoCnyPrecise(nanoCny: number): string {
  if (!Number.isFinite(nanoCny) || nanoCny <= 0) return '¥0';
  return `¥${stripTrailingZeros((nanoCny / NANO_PER_CNY).toFixed(9))}`;
}

/** Token 数：≥1000 用 k，保留一位小数（18400 → 18.4k） */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count < 1000) return String(Math.round(count));
  return `${stripTrailingZeros((count / 1000).toFixed(1))}k`;
}

/** 缓存命中率 0.636 → "63.6%" */
export function formatCacheHitRate(rate: number): string {
  return `${stripTrailingZeros((rate * 100).toFixed(1))}%`;
}
