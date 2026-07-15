/**
 * 检索评测 · CI 门禁（fixture 版，P0-1 修复）
 *
 * 与 retrieval.eval.test.ts（真实仓库版，data/.aiops 缺失时 skip）不同：
 * 本套件针对随仓库提交的 test/eval/fixture-repo 现场建图，**永不 skip**——
 * 这是 CI 上唯一真实生效的检索棘轮。fixture 小而稳，阈值可以设得比真实仓库狠。
 *
 * 运行：pnpm --filter @aiops/api test fixture
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadFixtureGraph, loadJsonl, runRetrievalCase, scoreCase, aggregate, formatReport } from './harness.ts';
import type { RetrievalCase, AggregateReport } from './types.ts';

const K = 10;
/** fixture 稳定且简单：召回 ≥ 0.85、MRR ≥ 0.7（当前基线满分，留抖动余量）。 */
const THRESHOLD = { recallAtK: 0.85, mrr: 0.7 };

describe('检索评测 · CI 门禁（fixture）', () => {
  let report: AggregateReport;

  beforeAll(async () => {
    await loadFixtureGraph();
    const cases = loadJsonl<RetrievalCase>('./dataset/fixture-retrieval.jsonl');
    const scores = cases.map((c) => scoreCase(runRetrievalCase(c), K));
    report = aggregate(scores, K);
    console.log('\n' + formatReport(report) + '\n');
  });

  it('fixture 数据集非空且成功跑完', () => {
    expect(report.total).toBeGreaterThanOrEqual(8);
  });

  it(`宏平均 Recall@${K} ≥ ${THRESHOLD.recallAtK}`, () => {
    expect(report.recallAtK).toBeGreaterThanOrEqual(THRESHOLD.recallAtK);
  });

  it(`MRR ≥ ${THRESHOLD.mrr}`, () => {
    expect(report.mrr).toBeGreaterThanOrEqual(THRESHOLD.mrr);
  });
});
