/**
 * 检索评测（Layer 1）· vitest 门禁
 *
 * 作用：把召回质量变成「可回归的数字」，并对聚合指标设阈值门禁（CI 红/绿）。
 * 这一层完全离线、确定性、无需 LLM，是评测体系里最便宜、最该先做、也最该进 CI 的一层。
 *
 * 运行：pnpm --filter @aiops/api test            （全量）
 *      pnpm --filter @aiops/api test retrieval   （只跑这一支）
 *
 * 注意：data/.aiops 被 gitignore，缺图时本套件自动 skip，不拖垮 pnpm test。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { graphExists, loadEvalGraph, loadJsonl, runRetrievalCase, scoreCase, aggregate, formatReport } from './harness.ts';
import type { RetrievalCase, AggregateReport } from './types.ts';

const REPO = process.env.EVAL_REPO ?? 'elink-pc';
const K = Number(process.env.EVAL_K ?? 10);

/**
 * 门禁阈值（棘轮）：设「略低于当前基线」的地板，从此只许涨不许跌。
 * 当前基线（18 条，en/zh 变体配对，纯词法通道）：Recall@10=0.556 / MRR=0.426。
 * 留抖动余量设 0.5 / 0.38——图重建/数据集微调时不至于误报红。
 * 注意：本门禁只测确定性的词法召回（CI 无 embedding）；语义通道的收益/回归
 * 用 `pnpm --filter @aiops/api eval -- semantic` 按需对比，融合权重调好后再抬棘轮。
 */
const THRESHOLD = { recallAtK: 0.5, mrr: 0.38 };

describe.skipIf(!graphExists(REPO))('检索评测 · Layer 1', () => {
  let report: AggregateReport;

  beforeAll(() => {
    loadEvalGraph(REPO);
    const cases = loadJsonl<RetrievalCase>('./dataset/retrieval.jsonl');
    const scores = cases.map((c) => scoreCase(runRetrievalCase(c), K));
    report = aggregate(scores, K);
    // 把明细打进测试输出，方便你逐条看哪些没命中。
    console.log('\n' + formatReport(report) + '\n');
  });

  it('数据集非空且成功跑完（wiring sanity）', () => {
    expect(report.total).toBeGreaterThan(0);
  });

  it(`宏平均 Recall@${K} ≥ ${THRESHOLD.recallAtK}`, () => {
    expect(report.recallAtK).toBeGreaterThanOrEqual(THRESHOLD.recallAtK);
  });

  it(`MRR ≥ ${THRESHOLD.mrr}`, () => {
    expect(report.mrr).toBeGreaterThanOrEqual(THRESHOLD.mrr);
  });
});
