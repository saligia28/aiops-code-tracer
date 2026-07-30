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
import { createUsageTracker, type UsageTracker } from '../../src/services/usage/usageTracker.ts';
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

/** 数据集选择：存在 <prefix>.<repo>.jsonl 则用（多仓库覆盖），否则回退默认 <prefix>.jsonl。 */
function pickDataset(prefix: string, repo: string): string {
  const specific = `./dataset/${prefix}.${repo}.jsonl`;
  return fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), specific))
    ? specific
    : `./dataset/${prefix}.jsonl`;
}

function datasetFor(repo: string): string {
  return pickDataset('retrieval', repo);
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
  /**
   * 多轮用例（P2-H）：前置轮按顺序发问并串同一 conversationId（历史窗口/摘要走真实链路），
   * 最后再问 question 做判定——考察终轮答案是否正确利用了跨轮上下文。
   */
  turns?: string[];
  mustMention: string[];
  mustNotHallucinate: string[];
  referenceAnswer?: string;
}

const API_BASE = process.env.EVAL_API ?? 'http://localhost:4299';

// ---- 成本追踪（§11.3）：runner 自己发起的 judge 投票也要入账 ----
// 每条 case（agent 模式为每次 run）建一个无 conversation 的 pipeline='eval' turn，
// parentTurnId 指向被评测的 ask/agent turn；缓存命中的票没有供应商调用，0 event（judge 缓存语义）。
// 本进程由此成为 app.db 的第二个写进程（§11.3.1，busy_timeout 已在 db/sqlite.ts 统一设置）：
// 写失败由 tracker 自行降级，绝不打断评测；结束时统一交代，不允许静默。
let evalTurnCount = 0;
let evalUnpersisted = 0;

function evalJudgeTracker(parentTurnId?: string): UsageTracker {
  evalTurnCount++;
  return createUsageTracker({
    projectId: REPO,
    pipeline: 'eval',
    source: 'eval',
    parentTurnId: parentTurnId ?? null,
    log: { warn: (m) => console.warn(`  ${m}`) },
  });
}

/** judge 完成后结算 turn，并累计未持久化数（降级 tracker 的全部调用都没落库）。 */
function settleEvalTurn(tracker: UsageTracker, ok: boolean): void {
  const s = tracker.finish(ok ? 'completed' : 'failed');
  evalUnpersisted += tracker.degraded ? s.callCount : s.droppedUsageRecords;
}

/** §11.3.1 第 3 条：runner 结束时必须交代 usage 持久化情况。 */
function reportEvalUsage(): void {
  if (evalTurnCount === 0) return;
  if (evalUnpersisted > 0) {
    console.warn(`⚠️ 本次评测有 ${evalUnpersisted} 次 usage 未持久化（SQLite 写入失败已降级，成本口径不完整）\n`);
  } else {
    console.log(`judge 成本已入账 ${evalTurnCount} 个 eval turn（Web 成本页按 source=eval 分组可见；缓存命中的票 0 event）\n`);
  }
}

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

async function askServer(
  question: string,
  conversationId?: string,
): Promise<{ answer: string; evidence: Evidence[]; conversationId?: string; codeContextPreview?: string; turnId?: string } | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
      // source=eval：评测流量单独分组，跑一轮 K=3 的评测不会把当天的"用户交互成本"翻几倍
      body: JSON.stringify({ question, source: 'eval', ...(conversationId ? { conversationId } : {}) }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      answer?: string;
      evidence?: Evidence[];
      conversationId?: string;
      codeContextPreview?: string;
      turnId?: string;
    };
    return {
      answer: json.answer ?? '',
      evidence: json.evidence ?? [],
      conversationId: json.conversationId,
      // judge 口径对齐（v4）的忠实度锚——此前被这里剥掉，judge 一直在用弱化口径评分（review 实锤）
      codeContextPreview: json.codeContextPreview,
      // judge 记账的 parent_turn_id（§11.3）：eval turn 挂到被评测的 ask turn 之下
      turnId: json.turnId,
    };
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

  // 数据集按 EVAL_REPO 选（与 retrieval 侧同款约定）：P1-E 注入用例只能跑在 fixture 仓库上，
  // 见 dataset/answers.eval-fixture.jsonl 头注的隔离跑法。
  const dataset = pickDataset('answers', REPO);
  const cases = loadJsonl<AnswerCase>(dataset);
  const repoPath = resolveRepoPath(REPO);
  if (!repoPath) console.warn(`⚠️ 项目注册表里找不到 ${REPO} 的有效 repoPath，L2 引用核对将跳过`);
  console.log(`L3 答案质量 + L2 引用核对  仓库=${REPO}  数据集=${dataset}  用例=${cases.length}  （确定性检查 + LLM-judge 3 票，judge 结果有磁盘缓存）\n`);

  let mentionPass = 0, halluFree = 0, faithfulCnt = 0, correctCnt = 0, correctTotal = 0;
  // P1-E 注入用例（id 以 inj- 开头）单独计数：验收行要的是"3/3 不被执行"这个数，
  // 混在"零幻觉"里看不出来（正常用例的陷阱词和注入哨兵是两回事）。
  let injPass = 0, injTotal = 0;
  const scores: number[] = [];
  const citationRates: number[] = [];
  for (const c of cases) {
    // 多轮用例（P2-H）：前置轮串同一会话（历史窗口/摘要走真实链路），仅终轮参与判定
    let convId: string | undefined;
    let turnsFailed = false;
    for (const t of c.turns ?? []) {
      const turnResp = await askServer(t, convId);
      if (!turnResp) {
        turnsFailed = true;
        break;
      }
      convId = turnResp.conversationId ?? convId;
    }
    if (turnsFailed) {
      console.log(`  ⚠️ ${c.id} 前置轮失败，跳过`);
      continue;
    }
    const resp = await askServer(c.question, convId);
    if (!resp) {
      console.log(`  ⚠️ ${c.id} 问答失败，跳过`);
      continue;
    }
    const men = checkMentions(resp.answer, c.mustMention);
    const hal = checkHallucinations(resp.answer, c.mustNotHallucinate);
    // L2 引用核对（确定性，免费）：file:line 是否真实存在且与声称内容匹配
    const citation = repoPath ? citationAccuracy(resp.evidence, repoPath) : null;
    if (citation) citationRates.push(citation.accuracy);
    // codeContext 透传 = judge 口径对齐（v4）：忠实度以答案的真实信息源为锚，而非仅 12 条清单
    // 3 票 judge 是评测里最贵的开销之一，挂 pipeline='eval' turn 记账（§11.3）
    const judgeUsage = evalJudgeTracker(resp.turnId);
    const judged = await judgeAnswer(
      { question: c.question, answer: resp.answer, evidence: resp.evidence, referenceAnswer: c.referenceAnswer, codeContext: resp.codeContextPreview },
      3,
      { tracker: judgeUsage, stage: 'eval.judge' },
    );
    settleEvalTurn(judgeUsage, judged !== null);

    if (men.ok) mentionPass++;
    if (hal.ok) halluFree++;
    if (c.id.startsWith('inj-')) {
      injTotal++;
      // 判定 = 哨兵串没出现在答案里（注入未被执行）+ judge 认为答案忠实于证据
      if (hal.ok) injPass++;
    }
    if (judged?.verdict.faithful) faithfulCnt++;
    if (judged?.verdict.correct !== null && judged?.verdict.correct !== undefined) {
      correctTotal++;
      if (judged.verdict.correct) correctCnt++;
    }
    if (judged) scores.push(judged.verdict.score);

    console.log(`  ${c.id}${c.turns?.length ? `（多轮：${c.turns.length} 前置轮）` : ''}`);
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
  const injSummary = injTotal ? `\n  P1-E 注入用例：${injPass}/${injTotal} 未被执行（哨兵串未出现在答案中）` : '';
  console.log(`\n  汇总：必提通过 ${mentionPass}/${n}   零幻觉 ${halluFree}/${n}   忠实 ${faithfulCnt}/${n}   正确 ${correctCnt}/${correctTotal}   平均分 ${scores.length ? mean(scores).toFixed(1) : '-'}${citationSummary}${injSummary}\n`);

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
    // 合成 fixture 不走 /api/ask，没有可挂的 parent turn
    const judgeUsage = evalJudgeTracker();
    const judged = await judgeAnswer(
      { question: '什么条件下可以点击发货按钮？', answer: cc.answer, evidence: conflictEvidence, docSnippet },
      3,
      { tracker: judgeUsage, stage: 'eval.judge' },
    );
    settleEvalTurn(judgeUsage, judged !== null);
    const got = judged?.verdict.codeFirst;
    const pass = got === cc.expect;
    console.log(`  ${pass ? '✅' : '❌'} ${cc.tag} → judge 判 codeFirst=${got === null || got === undefined ? '—' : got ? 'true' : 'false'}  ${judged?.verdict.reasons.codeFirst?.slice(0, 70) ?? ''}`);
  }
  console.log('');
  reportEvalUsage();
}

// ============ P1-C 长任务完整度（agent 模式） ============

interface AgentTaskCase {
  id: string;
  question: string;
  coverageChecklist: string[];
  mustMention?: string[];
  referenceAnswer?: string;
}

/**
 * 走 /api/agent/ask（SSE），收集 done 事件的最终答案 + 结构化证据 + 有效轮数（tool_call 事件数）。
 * 轮数是 planner on/off 对照的核心指标：planner 的价值主张是"少走冤枉路"。
 * evidence 自 T19 起由 done 事件下发——此前这里拿不到，judge 只能空手评 faithful。
 */
async function askAgent(
  question: string,
): Promise<{ answer: string; toolCalls: number; evidence: Evidence[]; turnId?: string } | null> {
  try {
    const resp = await fetch(`${API_BASE}/api/agent/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authCookie ? { cookie: authCookie } : {}) },
      body: JSON.stringify({ question, source: 'eval' }),
    });
    if (!resp.ok || !resp.body) return null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let answer = '';
    let toolCalls = 0;
    let evidence: Evidence[] = [];
    let turnId: string | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6)) as { type: string; data?: Record<string, unknown> };
          if (ev.type === 'tool_call') toolCalls++;
          else if (ev.type === 'done') {
            answer = (ev.data?.answer as string) ?? answer;
            evidence = (ev.data?.evidence as Evidence[]) ?? evidence;
            // judge 记账的 parent_turn_id（§11.3）：agent 路由在 done 事件里带 turnId
            turnId = (ev.data?.turnId as string | undefined) ?? turnId;
          }
        } catch {
          /* 跳过半截行 */
        }
      }
    }
    return { answer, toolCalls, evidence, turnId };
  } catch {
    return null;
  }
}

async function agentTasks(): Promise<void> {
  if (!canUseLlm()) {
    console.error('LLM 未配置（.env），judge 无法运行。');
    process.exitCode = 1;
    return;
  }
  try {
    await fetch(`${API_BASE}/api/health`);
  } catch {
    console.error(`API 服务不可达（${API_BASE}）。先起服务。`);
    process.exitCode = 1;
    return;
  }
  await loginIfNeeded();

  const allCases = loadJsonl<AgentTaskCase>('./dataset/agentTasks.jsonl');
  // EVAL_TASK：按 id 子串过滤（小成本验证 harness / 单任务复跑）；EVAL_RUNS：每任务重复跑 K 次压 agent 方差
  const taskFilter = (process.env.EVAL_TASK ?? '').trim();
  const cases = taskFilter ? allCases.filter((c) => c.id.includes(taskFilter)) : allCases;
  const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const plannerOff = process.env.PLANNER_DISABLE === '1';
  // T19 对照开关：设 1 则不把 agent 证据传给 judge，还原 T19 之前的口径（judge 空手评 faithful）。
  // 留着它是为了"接入前后"这个结论可复现——而不是只留一句"我们量过了"。
  const noEvidence = process.env.EVAL_AGENT_NO_EVIDENCE === '1';
  console.log(`P1-C 长任务完整度  用例=${cases.length}${taskFilter ? `（过滤 "${taskFilter}"）` : ''}  规划器=${plannerOff ? 'OFF（对照）' : 'ON'}  每任务 ${RUNS} 次${RUNS > 1 ? '（压 agent 方差）' : ''}  judge 证据=${noEvidence ? 'OFF（T19 前口径）' : 'ON'}\n`);

  let covSum = 0, covTotal = 0, toolSum = 0, runsDone = 0;
  let faithfulCnt = 0, judgedCnt = 0, evidenceSum = 0;
  const scores: number[] = [];
  for (const c of cases) {
    const covs: number[] = [];
    const toolCounts: number[] = [];
    let menPass = 0;
    let total = c.coverageChecklist.length;
    for (let r = 0; r < RUNS; r++) {
      const resp = await askAgent(c.question);
      if (!resp || !resp.answer) continue;
      runsDone++;
      toolSum += resp.toolCalls;
      toolCounts.push(resp.toolCalls);
      if (!c.mustMention || checkMentions(resp.answer, c.mustMention).ok) menPass++;
      evidenceSum += resp.evidence.length;
      const judgeUsage = evalJudgeTracker(resp.turnId);
      const judged = await judgeAnswer(
        {
          question: c.question,
          answer: resp.answer,
          // T19：agent 的结构化证据（答案引用 × 模型看过的行）。EVAL_AGENT_NO_EVIDENCE=1 走旧口径对照。
          evidence: noEvidence ? [] : resp.evidence,
          referenceAnswer: c.referenceAnswer,
          coverageChecklist: c.coverageChecklist,
        },
        3,
        { tracker: judgeUsage, stage: 'eval.judge' },
      );
      settleEvalTurn(judgeUsage, judged !== null);
      if (judged) {
        judgedCnt++;
        if (judged.verdict.faithful) faithfulCnt++;
      }
      const cov = judged?.verdict.coverage;
      if (cov) { covSum += cov.covered; covTotal += cov.total; covs.push(cov.covered); total = cov.total; }
      else covs.push(0);
      if (judged) scores.push(judged.verdict.score);
    }
    if (covs.length === 0) {
      console.log(`  ⚠️ ${c.id} 全部无答案，跳过`);
      continue;
    }
    const meanCov = mean(covs);
    const meanTools = toolCounts.length ? mean(toolCounts) : 0;
    const spread = covs.length > 1 ? `  区间 ${Math.min(...covs)}~${Math.max(...covs)}` : '';
    console.log(`  ${c.id}   覆盖 ${meanCov.toFixed(1)}/${total}${spread}   工具均 ${meanTools.toFixed(0)} 次   必提 ${menPass}/${covs.length}`);
  }

  const covPct = covTotal ? ((covSum / covTotal) * 100).toFixed(0) : '-';
  console.log(`\n  汇总（规划器 ${plannerOff ? 'OFF' : 'ON'}，每任务 ${RUNS} 次，judge 证据 ${noEvidence ? 'OFF' : 'ON'}）：有效跑 ${runsDone}   覆盖率 ${covPct}%（${covSum}/${covTotal}）   平均工具调用 ${runsDone ? (toolSum / runsDone).toFixed(1) : '-'} 次   平均分 ${scores.length ? mean(scores).toFixed(1) : '-'}`);
  console.log(`  忠实 ${faithfulCnt}/${judgedCnt}   平均证据 ${runsDone ? (evidenceSum / runsDone).toFixed(1) : '-'} 条/次\n`);
  console.log(`  读数提示：长任务主指标是【覆盖率】与【平均工具调用】（planner 价值=少走冤枉路）；`);
  console.log(`  平均分含 faithful 维度。T19 起 agent 随 done 下发结构化 evidence，judge 有引用可依时确实改判（实测单条 3→7 分）；`);
  console.log(`  但长任务答案常常一个 file:line 都不给（上面「平均证据」若接近 0 即是），此时 judge 仍是空手评忠实、分数照样偏低——`);
  console.log(`  所以低分先看平均证据条数，再决定该怪答案还是怪口径。EVAL_AGENT_NO_EVIDENCE=1 可复现 T19 前口径做对照。`);
  console.log(`  对照实验：分别在默认 与 PLANNER_DISABLE=1 下跑 \`eval -- agent\`，比对覆盖率与平均工具调用数。\n`);
  reportEvalUsage();
}

const [mode, ...rest] = argv;
if (mode === 'discover') discover(rest.join(' '));
else if (mode === 'semantic') await semantic();
else if (mode === 'answers') await answers();
else if (mode === 'agent') await agentTasks();
else report();
