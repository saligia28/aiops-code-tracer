/**
 * 评测通道 · 检索指标（纯函数，可单测）
 *
 * 这是评测的「原理层」：刻意做成不依赖任何全局状态的纯函数，输入两个字符串数组就能算。
 * 你要能对着这几行讲清楚 Recall@K / MRR 的定义——它们是一切检索评测的地基。
 */

/**
 * Recall@K：期望集合里，有多少比例落在「前 K 个」召回中。
 * 关注「该找到的有没有找到」，是 RAG 检索层最核心的指标。
 */
export function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const topK = new Set(retrieved.slice(0, k));
  const hit = expected.filter((e) => topK.has(e)).length;
  return hit / expected.length;
}

/** 第一个命中期望的名次（1-based）；未命中返回 null。 */
export function firstHitRank(retrieved: string[], expected: string[]): number | null {
  const want = new Set(expected);
  for (let i = 0; i < retrieved.length; i++) {
    if (want.has(retrieved[i])) return i + 1;
  }
  return null;
}

/**
 * Reciprocal Rank：1 / 第一个命中的名次；未命中为 0。
 * 一组用例的 RR 求平均 = MRR，衡量「正确结果排得够不够靠前」。
 */
export function reciprocalRank(retrieved: string[], expected: string[]): number {
  const rank = firstHitRank(retrieved, expected);
  return rank ? 1 / rank : 0;
}

/**
 * Precision@K：前 K 个召回里，有多少比例是期望的。
 * 关注「找回来的准不准」，与 Recall 是一对权衡（先不进门禁，做诊断用）。
 */
export function precisionAtK(retrieved: string[], expected: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const want = new Set(expected);
  const hit = topK.filter((r) => want.has(r)).length;
  return hit / topK.length;
}

/** 算术平均（空数组返回 0）。 */
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
