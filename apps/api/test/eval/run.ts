/**
 * 评测通道 · 独立运行器（给人看的报表 + 标注辅助）
 *
 * CI 门禁走 *.test.ts；这个脚本给你交互式地看数字、标数据。
 *
 * 用法：
 *   pnpm --filter @aiops/api eval
 *       跑整个数据集，打印 Recall@K / MRR 报表。
 *
 *   pnpm --filter @aiops/api eval -- discover "作废订单在哪里做的校验"
 *       探查某个问题的召回前 K 个文件——用来给 dataset 标 expectedFiles。
 *
 *   EVAL_REPO=quality EVAL_K=5 pnpm --filter @aiops/api eval
 *       换仓库 / 换 K。
 *
 *   pnpm --filter @aiops/api eval -- answers
 *       L3 答案质量：真实问答 → 确定性检查(mustMention/幻觉陷阱) + LLM-judge 三票。
 *       前置：本地 API 服务已起并加载 elink-pc（见 _probe_citation.ts 头注的启动命令）。
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Evidence } from '@aiops/shared-types';
import { loadEvalGraph, loadJsonl, runRetrievalCase, scoreCase, aggregate, formatReport, toRetrievedFiles } from './harness.ts';
import { firstHitRank, recallAtK, reciprocalRank, mean } from './metrics.ts';
import { findRelevantNodes, findRelevantNodesWithSemantic } from '../../src/services/ask/recall.ts';
import { loadSemanticFileIndex, buildSemanticFileIndex } from '../../src/services/ask/semanticRecall.ts';
import { checkMentions, checkHallucinations, judgeAnswer, canUseLlm } from './judge.ts';
import { citationAccuracy } from './citation.ts';
import { DATA_DIR } from '../../src/context.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { RetrievalCase } from './types.ts';

const REPO = process.env.EVAL_REPO ?? 'elink-pc';
const K = Number(process.env.EVAL_K ?? 10);
// 召回深度：findRelevantNodes 取多少个节点再去重成文件。默认 60（与生产 ask 路由一致）。
// 诊断时可调大（如 300）看某文件是「被埋在后面」还是「根本没进候选」。
const MAXR = Number(process.env.EVAL_MAXR ?? 60);

/** 数据集选择：存在 retrieval.<repo>.jsonl 则用（多仓库覆盖），否则回退默认 retrieval.jsonl。 */
function datasetFor(repo: string): string {
  const specific = `./dataset/retrieval.${repo}.jsonl`;
  return fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), specific)) ? specific : './dataset/retrieval.jsonl';
}

function report(): void {
  loadEvalGraph(REPO);
  const cases = loadJsonl<RetrievalCase>(datasetFor(REPO));
  const scores = cases.map((c) => scoreCase(runRetrievalCase(c, MAXR), K));
  console.log(`\n仓库=${REPO}  数据集=${datasetFor(REPO)}`);
  console.log(formatReport(aggregate(scores, K)) + '\n');
}

function discover(question: string): void {
  if (!question.trim()) {
    console.error('用法：pnpm --filter @aiops/api eval -- discover "你的问题"');
    process.exitCode = 1;
    return;
  }
  loadEvalGraph(REPO);
  const { retrievedFiles } = runRetrievalCase({ id: 'adhoc', question, expectedFiles: [] }, MAXR);
  console.log(`\n仓库=${REPO}   问题：${question}`);
  console.log(`召回前 ${K} 文件（把正确的复制进 dataset/retrieval.jsonl 的 expectedFiles）：\n`);
  retrievedFiles.slice(0, K).forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
  console.log('');
}

// 兼容 `pnpm eval -- discover "x"`（部分 pnpm 版本会把分隔符 '--' 一并透传进来）。
const argv = process.argv.slice(2).filter((a) => a !== '--');
/**
 * 语义对比模式：同一批用例，纯词法 vs 词法+语义（Gap B 修复）并排跑，看每条名次变化 + 聚合 delta。
 * 首次运行会构建并持久化语义索引（需 ollama/embedding 就绪），之后从磁盘 load。
 * 例：EMBEDDING_PROVIDER=ollama EMBEDDING_BASE_URL=http://localhost:11434/v1 EMBEDDING_MODEL=bge-m3 \
 *     pnpm --filter @aiops/api eval -- semantic
 */
async function semantic(): Promise<void> {
  loadEvalGraph(REPO);
  if (!loadSemanticFileIndex(REPO)) {
    console.log('语义索引不存在，开始构建（需 embedding 就绪；bge-m3 首次较慢）…\n');
    const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) } as unknown as FastifyBaseLogger;
    const built = await buildSemanticFileIndex(REPO, log);
    if (!built) {
      console.error('\n构建失败：embedding 未就绪。请设 EMBEDDING_PROVIDER=ollama EMBEDDING_BASE_URL=http://localhost:11434/v1 EMBEDDING_MODEL=bge-m3');
      process.exitCode = 1;
      return;
    }
    console.log(`\n语义索引已构建并持久化：${built.built} 文件\n`);
  }

  const cases = loadJsonl<RetrievalCase>('./dataset/retrieval.jsonl');
  const lexR: number[] = [], lexRR: number[] = [], semR: number[] = [], semRR: number[] = [];
  console.log(`仓库=${REPO}  用例=${cases.length}  K=${K}   （词法 → 词法+语义）\n`);
  for (const c of cases) {
    const lex = toRetrievedFiles(findRelevantNodes(c.question, MAXR));
    const sem = toRetrievedFiles(await findRelevantNodesWithSemantic(c.question, MAXR));
    const lr = firstHitRank(lex, c.expectedFiles);
    const sr = firstHitRank(sem, c.expectedFiles);
    lexR.push(recallAtK(lex, c.expectedFiles, K)); lexRR.push(reciprocalRank(lex, c.expectedFiles));
    semR.push(recallAtK(sem, c.expectedFiles, K)); semRR.push(reciprocalRank(sem, c.expectedFiles));
    const flip = !lr && sr ? '  🎯翻正' : lr && !sr ? '  ⚠️翻负' : '';
    console.log(`  ${lr ? '✅' : '❌'}→${sr ? '✅' : '❌'}  rank ${String(lr ?? '-').padStart(3)} → ${String(sr ?? '-').padStart(3)}${flip}   ${c.question}`);
  }
  console.log(`\n  Recall@${K}: 词法 ${mean(lexR).toFixed(3)} → 语义 ${mean(semR).toFixed(3)}`);
  console.log(`  MRR      : 词法 ${mean(lexRR).toFixed(3)} → 语义 ${mean(semRR).toFixed(3)}\n`);
}

// ============ L3 答案质量（answers 模式） ============

interface AnswerCase {
  id: string;
  question: string;
  mustMention: string[];
  mustNotHallucinate: string[];
  referenceAnswer?: string;
}

const API_BASE = process.env.EVAL_API ?? 'http://localhost:4299';

/** 从项目注册表解析被分析仓库的磁盘路径（L2 引用核对要读真实源码）。 */
function resolveRepoPath(repoId: string): string | null {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf-8')) as Array<{ id?: string; repoPath?: string }>;
    const hit = (Array.isArray(registry) ? registry : []).find((p) => p.id === repoId);
    return hit?.repoPath && fs.existsSync(hit.repoPath) ? hit.repoPath : null;
  } catch {
    return null;
  }
}

/** 目标服务开了鉴权（AUTH_PASSWORD）时，设 EVAL_API_PASSWORD 自动登录带 cookie。 */
let authCookie = '';
async function loginIfNeeded(): Promise<void> {
  const password = process.env.EVAL_API_PASSWORD;
  if (!password || authCookie) return;
  try {
    const resp = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    authCookie = resp.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!authCookie) console.warn('⚠️ EVAL_API_PASSWORD 登录失败（密码错误？），将匿名调用');
  } catch {
    // 服务不可达时由后续 health 检查报告
  }
}

async function askServer(question: string): Promise<{ answer: string; evidence: Evidence[] } | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
      body: JSON.stringify({ question }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { answer?: string; evidence?: Evidence[] };
    return { answer: json.answer ?? '', evidence: json.evidence ?? [] };
  } catch {
    return null;
  }
}

async function answers(): Promise<void> {
  if (!canUseLlm()) {
    console.error('LLM 未配置（.env），judge 无法运行。');
    process.exitCode = 1;
    return;
  }
  try {
    await fetch(`${API_BASE}/api/health`);
  } catch {
    console.error(`API 服务不可达（${API_BASE}）。先起服务，例如：\n  AUTH_PASSWORD= API_PORT=4299 EMBEDDING_PROVIDER=ollama EMBEDDING_BASE_URL=http://localhost:11434/v1 EMBEDDING_MODEL=bge-m3 pnpm exec tsx src/index.ts`);
    process.exitCode = 1;
    return;
  }
  await loginIfNeeded();

  const cases = loadJsonl<AnswerCase>('./dataset/answers.jsonl');
  const repoPath = resolveRepoPath(REPO);
  if (!repoPath) console.warn(`⚠️ 项目注册表里找不到 ${REPO} 的有效 repoPath，L2 引用核对将跳过`);
  console.log(`L3 答案质量 + L2 引用核对  用例=${cases.length}  （确定性检查 + LLM-judge 3 票，judge 结果有磁盘缓存）\n`);

  let mentionPass = 0, halluFree = 0, faithfulCnt = 0, correctCnt = 0, correctTotal = 0;
  const scores: number[] = [];
  const citationRates: number[] = [];
  for (const c of cases) {
    const resp = await askServer(c.question);
    if (!resp) {
      console.log(`  ⚠️ ${c.id} 问答失败，跳过`);
      continue;
    }
    const men = checkMentions(resp.answer, c.mustMention);
    const hal = checkHallucinations(resp.answer, c.mustNotHallucinate);
    // L2 引用核对（确定性，免费）：file:line 是否真实存在且与声称内容匹配
    const citation = repoPath ? citationAccuracy(resp.evidence, repoPath) : null;
    if (citation) citationRates.push(citation.accuracy);
    const judged = await judgeAnswer({ question: c.question, answer: resp.answer, evidence: resp.evidence, referenceAnswer: c.referenceAnswer });

    if (men.ok) mentionPass++;
    if (hal.ok) halluFree++;
    if (judged?.verdict.faithful) faithfulCnt++;
    if (judged?.verdict.correct !== null && judged?.verdict.correct !== undefined) {
      correctTotal++;
      if (judged.verdict.correct) correctCnt++;
    }
    if (judged) scores.push(judged.verdict.score);

    console.log(`  ${c.id}`);
    const citationText = citation ? `   引用 ${(citation.accuracy * 100).toFixed(0)}%${citation.accuracy < 1 ? ` (${citation.checks.filter((x) => !x.matched).length} 条未核实)` : ''}` : '';
    console.log(`    必提 ${men.ok ? '✅' : `❌ 缺: ${men.missing.join(', ')}`}   陷阱 ${hal.ok ? '✅' : `❌ 踩: ${hal.hits.join(', ')}`}${citationText}`);
    if (judged) {
      const v = judged.verdict;
      console.log(`    judge(${judged.votes.length}票) 忠实=${v.faithful ? '✅' : '❌'} 正确=${v.correct === null ? '—' : v.correct ? '✅' : '❌'} 评分=${v.score}/10  ${v.reasons.faithful.slice(0, 60)}`);
    } else {
      console.log('    judge 失败（LLM 无响应或 JSON 解析失败）');
    }
  }

  const n = cases.length;
  const citationSummary = citationRates.length ? `   引用准确率 ${(mean(citationRates) * 100).toFixed(0)}%` : '';
  console.log(`\n  汇总：必提通过 ${mentionPass}/${n}   零幻觉 ${halluFree}/${n}   忠实 ${faithfulCnt}/${n}   正确 ${correctCnt}/${correctTotal}   平均分 ${scores.length ? mean(scores).toFixed(1) : '-'}${citationSummary}\n`);

  // ---- 代码优先冲突用例（合成 fixture，验 judge 的裁决力，不走 /api/ask）----
  console.log('代码优先（合成冲突：代码 status===2 vs 文档 status===1）：');
  const conflictEvidence: Evidence[] = [
    { file: 'src/views/deliveryManagement/tailoringDeliver/BookWarehouseSend.vue', line: 300, code: "visible: row.status === 2 && this.userInfo.type === 1", label: 'UI 条件' },
  ];
  const docSnippet = '《运营手册》(2024-03)：状态为 1（待约仓）的单据可点击「发货」按钮。';
  const conflictCases = [
    { tag: '答案以代码为准（期望 codeFirst=✅）', expect: true, answer: '按当前代码实现，「发货」按钮在 row.status === 2 且用户类型为 1 时可见（BookWarehouseSend.vue:300）。文档写的 status===1 与代码不符，应以代码为准，文档可能已过时。' },
    { tag: '答案照抄文档（期望 codeFirst=❌）', expect: false, answer: '根据运营手册，状态为 1（待约仓）的单据可以点击「发货」按钮。' },
  ];
  for (const cc of conflictCases) {
    const judged = await judgeAnswer({ question: '什么条件下可以点击发货按钮？', answer: cc.answer, evidence: conflictEvidence, docSnippet });
    const got = judged?.verdict.codeFirst;
    const pass = got === cc.expect;
    console.log(`  ${pass ? '✅' : '❌'} ${cc.tag} → judge 判 codeFirst=${got === null || got === undefined ? '—' : got ? 'true' : 'false'}  ${judged?.verdict.reasons.codeFirst?.slice(0, 70) ?? ''}`);
  }
  console.log('');
}

const [mode, ...rest] = argv;
if (mode === 'discover') discover(rest.join(' '));
else if (mode === 'semantic') await semantic();
else if (mode === 'answers') await answers();
else report();
