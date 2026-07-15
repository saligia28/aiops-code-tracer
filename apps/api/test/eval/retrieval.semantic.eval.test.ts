/**
 * 检索评测 · 语义门禁（P0-2 修复：让"生产真正在跑的通道"也有自动化回归检查）
 *
 * 背景：CI 词法门禁（fixture 版）测不到语义 RRF 融合——那是生产 /api/ask 的真实通道。
 * 本套件在「环境就绪」的机器上自动生效（elink 图 + embedding 配置 + 语义索引三者齐备），
 * 不就绪时 skip/软过；embedding 后端临时挂掉时语义自动退化为词法，断言天然不误报。
 *
 * 两条断言：
 *  1. 语义通道整体不弱于词法（融合不许出现净回归——这正是当年 ×14 翻车的那类问题）
 *  2. 语义 Recall@10 ≥ 0.7（当前基线 0.778，留抖动余量）
 *
 * 显式跑：EMBEDDING_PROVIDER=ollama EMBEDDING_BASE_URL=http://localhost:11434/v1 \
 *        EMBEDDING_MODEL=bge-m3 pnpm --filter @aiops/api test semantic
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { canUseEmbedding } from '../../src/services/embeddingService.ts';
import { loadSemanticFileIndex } from '../../src/services/ask/semanticRecall.ts';
import { findRelevantNodesWithSemantic } from '../../src/services/ask/recall.ts';
import { graphExists, loadEvalGraph, loadJsonl, runRetrievalCase, toRetrievedFiles } from './harness.ts';
import { recallAtK, mean } from './metrics.ts';
import type { RetrievalCase } from './types.ts';

const REPO = process.env.EVAL_REPO ?? 'elink-pc';
const K = 10;
const THRESHOLD = { semanticRecall: 0.7 };

describe.skipIf(!graphExists(REPO) || !canUseEmbedding())('检索评测 · 语义门禁', () => {
  let ready = false;
  let lexRecall = 0;
  let semRecall = 0;

  beforeAll(async () => {
    loadEvalGraph(REPO);
    // 索引缺失/与当前 embedding 模型不匹配 → 软过（打印原因），不假红
    if (!loadSemanticFileIndex(REPO)) {
      console.warn('[semantic-gate] 语义索引缺失或与当前模型不匹配，本次软过；先跑 eval -- semantic 构建');
      return;
    }
    const cases = loadJsonl<RetrievalCase>('./dataset/retrieval.jsonl');
    const lex: number[] = [];
    const sem: number[] = [];
    for (const c of cases) {
      lex.push(recallAtK(runRetrievalCase(c).retrievedFiles, c.expectedFiles, K));
      const semFiles = toRetrievedFiles(await findRelevantNodesWithSemantic(c.question, 60));
      sem.push(recallAtK(semFiles, c.expectedFiles, K));
    }
    lexRecall = mean(lex);
    semRecall = mean(sem);
    ready = true;
    console.log(`\n[semantic-gate] 词法 Recall@${K}=${lexRecall.toFixed(3)} → 语义 ${semRecall.toFixed(3)}\n`);
  });

  it('语义通道整体不弱于词法（融合无净回归）', () => {
    if (!ready) return;
    expect(semRecall).toBeGreaterThanOrEqual(lexRecall);
  });

  it(`语义 Recall@${K} ≥ ${THRESHOLD.semanticRecall}`, () => {
    if (!ready) return;
    expect(semRecall).toBeGreaterThanOrEqual(THRESHOLD.semanticRecall);
  });
});
