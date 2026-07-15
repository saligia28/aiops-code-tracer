// 通用格式化工具

/** 日期格式化：yyyy-MM-dd */
export function formatDate(input: Date | string): string {
  const d = typeof input === 'string' ? new Date(input) : input
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 金额格式化：保留两位小数 */
export function formatMoney(amount: number): string {
  return amount.toFixed(2)
}
