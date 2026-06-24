// ============================================================
// 底层文本/分词/打分工具
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import type {
  GraphNode,
} from '@aiops/shared-types';


export function tokenizeForRecall(input: string): string[] {
  const rawTokens = input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const expanded: string[] = [];
  const chineseOnly = /^[\u4e00-\u9fa5]+$/;
  for (const token of rawTokens) {
    if (token.length < 2) continue;
    expanded.push(token);

    if (!chineseOnly.test(token)) continue;
    const maxLen = Math.min(token.length, 18);
    const limited = token.slice(0, maxLen);
    for (let n = 2; n <= 4; n++) {
      if (limited.length < n) break;
      for (let i = 0; i <= limited.length - n; i++) {
        expanded.push(limited.slice(i, i + n));
      }
    }
  }

  return Array.from(new Set(expanded)).filter((token) => token.length >= 2).slice(0, 200);
}


export function parseLine(loc: string): number {
  const line = Number(loc.split(':')[0] ?? '1');
  return Number.isFinite(line) && line > 0 ? line : 1;
}


export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


export const NODE_TYPE_SCORE: Partial<Record<GraphNode['type'], number>> = {
  function: 2.5,
  variable: 1.5,
  apiCall: 2,
  vuexAction: 2,
  vuexMutation: 2,
  computed: 1.2,
  component: 1.5,
  routeEntry: 1.5,
};


export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest / 4);
}
