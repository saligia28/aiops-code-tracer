// ============================================================
// 节点与事实召回
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import type {
  GraphNode,
} from '@aiops/shared-types';
import {
  graphStore,
  fileNodeMap,
  recallIndex,
  fileRecallIndex,
  factIndex,
  type FactKind,
  type CodeFact,
  type PlanConcern,
  type QuestionPlan,
} from '../../context.js';
import { NODE_TYPE_SCORE, tokenizeForRecall, parseLine } from './textUtils.js';
import { extractMethodNamesFromEventLine } from './codeScan.js';
import { extractSearchTerms, extractQuestionCoreTerms, extractButtonLabelKeywords } from './questionAnalysis.js';
import { semanticFileCandidates } from './semanticRecall.js';


function vectorRecallCandidates(question: string, maxResults: number = 80, extraTerms: string[] = []): Array<{ node: GraphNode; score: number }> {
  if (!recallIndex) return [];
  const queryTerms = extractSearchTerms(question, extraTerms);
  if (queryTerms.length === 0) return [];

  const qTf = new Map<string, number>();
  for (const token of queryTerms) {
    qTf.set(token, (qTf.get(token) ?? 0) + 1);
  }

  let qNormSum = 0;
  const qWeights = new Map<string, number>();
  for (const [token, count] of qTf.entries()) {
    const weight = count * (recallIndex.idf.get(token) ?? 1);
    qWeights.set(token, weight);
    qNormSum += weight * weight;
  }
  const qNorm = Math.sqrt(qNormSum) || 1;

  const scored: Array<{ node: GraphNode; score: number }> = [];
  for (const doc of recallIndex.docs) {
    let dot = 0;
    for (const [token, qWeight] of qWeights.entries()) {
      const dCount = doc.tf.get(token);
      if (!dCount) continue;
      const dWeight = dCount * (recallIndex.idf.get(token) ?? 1);
      dot += qWeight * dWeight;
    }

    if (dot <= 0) continue;
    let score = dot / (qNorm * doc.norm);
    score += (NODE_TYPE_SCORE[doc.node.type] ?? 0) / 10;
    scored.push({ node: doc.node, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}


function fileRecallCandidates(question: string, maxResults: number = 30, extraTerms: string[] = []): Array<{ filePath: string; score: number }> {
  if (!fileRecallIndex) return [];
  const queryTerms = extractSearchTerms(question, extraTerms);
  if (queryTerms.length === 0) return [];

  const qTf = new Map<string, number>();
  for (const token of queryTerms) {
    qTf.set(token, (qTf.get(token) ?? 0) + 1);
  }

  let qNormSum = 0;
  const qWeights = new Map<string, number>();
  for (const [token, count] of qTf.entries()) {
    const weight = count * (fileRecallIndex.idf.get(token) ?? 1);
    qWeights.set(token, weight);
    qNormSum += weight * weight;
  }
  const qNorm = Math.sqrt(qNormSum) || 1;

  const scored: Array<{ filePath: string; score: number }> = [];
  for (const doc of fileRecallIndex.docs) {
    let dot = 0;
    for (const [token, qWeight] of qWeights.entries()) {
      const dCount = doc.tf.get(token);
      if (!dCount) continue;
      const dWeight = dCount * (fileRecallIndex.idf.get(token) ?? 1);
      dot += qWeight * dWeight;
    }
    if (dot <= 0) continue;
    scored.push({
      filePath: doc.filePath,
      score: dot / (qNorm * doc.norm),
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}


/**
 * 打分核：把一个问题在图上召回到的候选节点累积成 id→{node,score} 分数表。
 * 词法四通道（name / 路径 / 向量 / 文件内容 TF-IDF）都在这里。抽出来是为了让
 * 同步的 findRelevantNodes 与带语义的 findRelevantNodesWithSemantic 复用同一套词法基座。
 */
function collectScoredNodes(question: string, maxResults: number, plan?: QuestionPlan): Map<string, { node: GraphNode; score: number }> {
  const scored = new Map<string, { node: GraphNode; score: number }>();
  if (!graphStore) return scored;
  const scopeTerms = tokenizeForRecall(plan?.scope ?? '').slice(0, 8);
  const terms = extractSearchTerms(question, [...(plan?.keywords ?? []), ...scopeTerms]);

  for (const term of terms) {
    if (term.length < 2) continue;
    const hits = graphStore.searchByName(term).slice(0, 120);
    for (const node of hits) {
      const lowerName = node.name.toLowerCase();
      const lowerFile = node.filePath.toLowerCase();
      let score = 1;

      if (lowerName === term) score += 5;
      else if (lowerName.startsWith(term)) score += 3;
      else if (lowerName.includes(term)) score += 2;
      if (lowerFile.includes(term)) score += 1;
      if (scopeTerms.length > 0 && scopeTerms.some((token) => lowerFile.includes(token) || lowerName.includes(token))) {
        score += 2.5;
      }

      score += NODE_TYPE_SCORE[node.type] ?? 0;
      const prev = scored.get(node.id);
      if (prev) {
        prev.score += score;
      } else {
        scored.set(node.id, { node, score });
      }
    }
  }

  // 路径候选通道：让「功能/目录名只出现在文件路径里」的节点也能进候选。
  // 根因：上面的 name 命中只认 node.name，而像 List.vue 这类页面的节点按「动作」命名
  //（processPriceValidation / getTableData…），功能名只活在路径段（qsOrderMeetingPriceCheck）里，
  // 于是「按功能/目录名提问」永远进不了候选。这里按文件路径子串补一批候选。
  // 噪声控制：某词命中过多文件（> PATH_MATCH_FILE_CAP）说明它太常见（如 index/list/api），跳过——
  // 这是个自调节的稀有度闸门：越稀有的路径标识符命中越少，越该被信任。
  const PATH_MATCH_FILE_CAP = 40;
  for (const term of terms) {
    if (term.length < 3) continue; // 路径标识符一般较长；顺带排除中文 n-gram（路径是英文，命中不了）
    const matchedFiles: string[] = [];
    let tooCommon = false;
    for (const filePath of fileNodeMap.keys()) {
      if (!filePath.toLowerCase().includes(term)) continue;
      matchedFiles.push(filePath);
      if (matchedFiles.length > PATH_MATCH_FILE_CAP) { tooCommon = true; break; }
    }
    if (tooCommon || matchedFiles.length === 0) continue;
    for (const filePath of matchedFiles) {
      for (const node of (fileNodeMap.get(filePath) ?? []).slice(0, 40)) {
        // 温和加分：低于「精确 name 命中」（+5），确保「节点就叫这个」仍排在「只是同路径」之上。
        const boost = 4 + (NODE_TYPE_SCORE[node.type] ?? 0);
        const prev = scored.get(node.id);
        if (prev) prev.score += boost;
        else scored.set(node.id, { node, score: boost });
      }
    }
  }

  const vectorHits = vectorRecallCandidates(question, maxResults * 2, [...(plan?.keywords ?? []), ...scopeTerms]);
  for (const item of vectorHits) {
    const prev = scored.get(item.node.id);
    const hybridScore = item.score * 8;
    if (prev) {
      prev.score += hybridScore;
    } else {
      scored.set(item.node.id, { node: item.node, score: hybridScore });
    }
  }

  const fileHits = fileRecallCandidates(question, 25, [...(plan?.keywords ?? []), ...scopeTerms]);
  for (const [rank, fileHit] of fileHits.entries()) {
    const nodesInFile = (fileNodeMap.get(fileHit.filePath) ?? []).slice(0, 60);
    const rankDiscount = 1 / (1 + rank * 0.15);
    for (const node of nodesInFile) {
      const boost = fileHit.score * rankDiscount * (NODE_TYPE_SCORE[node.type] ?? 1);
      const prev = scored.get(node.id);
      if (prev) {
        prev.score += boost;
      } else {
        scored.set(node.id, { node, score: boost });
      }
    }
  }

  return scored;
}

/** 分数表排序取前 maxResults。 */
function rankTop(scored: Map<string, { node: GraphNode; score: number }>, maxResults: number): GraphNode[] {
  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.node);
}

/** 纯词法召回（同步、离线、确定性）。既有调用方行为不变。 */
export function findRelevantNodes(question: string, maxResults: number = 40, plan?: QuestionPlan): GraphNode[] {
  return rankTop(collectScoredNodes(question, maxResults, plan), maxResults);
}

/**
 * 词法 + 语义召回（异步）。桥接 Gap B（中文提问 × 英文标识符）。
 * 未构建/未就绪语义索引时自动退化为纯词法（== findRelevantNodes），零副作用。
 *
 * 融合用 RRF（Reciprocal Rank Fusion）而非加权加分——18 条评测扫参（W=5/8/14）证明
 * 加法融合无解：词法的文件内容 TF-IDF 命中绝对分很小（<1），语义 boost 任何权重都会
 * 把它挤下去；降权则轮到语义翻正的掉出。两通道分数刻度不可比，只有「排名空间」可比：
 *   fused(file) = Σ_通道 1/(RRF_K + rank_通道)
 * 双通道都命中的文件天然浮顶；单通道噪声只有一个信号，自然沉底。
 */
export async function findRelevantNodesWithSemantic(question: string, maxResults: number = 40, plan?: QuestionPlan): Promise<GraphNode[]> {
  const scored = collectScoredNodes(question, maxResults, plan);
  if (!graphStore) return rankTop(scored, maxResults);

  // 旋钮：env 可覆盖，供评测扫参；默认值由 test/eval 的 18 条数据集调定。
  const SEM_TOPN = Number(process.env.SEM_TOPN || '') || 10;
  const RRF_K = Number(process.env.SEM_RRF_K || '') || 20;
  const SEM_NODES_PER_FILE = Number(process.env.SEM_NODES_PER_FILE || '') || 3;

  const semFiles = await semanticFileCandidates(question, SEM_TOPN);
  if (semFiles.length === 0) return rankTop(scored, maxResults);

  // 词法侧取双倍深度的节点序 → 去重保序得到文件排名（1-based）。
  const lexNodes = rankTop(scored, maxResults * 2);
  const lexFileRank = new Map<string, number>();
  const nodesByFile = new Map<string, GraphNode[]>();
  for (const node of lexNodes) {
    if (!lexFileRank.has(node.filePath)) lexFileRank.set(node.filePath, lexFileRank.size + 1);
    const list = nodesByFile.get(node.filePath) ?? [];
    list.push(node);
    nodesByFile.set(node.filePath, list);
  }

  // 加权 RRF：语义项 ×SEM_RRF_SEM_W(<1)——平票时确定性的词法通道优先
  //（词法 rank1 的精确命中不该被语义 rank1 的薄边距相似度单独顶掉）。
  const SEM_RRF_SEM_W = Number(process.env.SEM_RRF_SEM_W || '') || 0.9;
  const fused = new Map<string, number>();
  for (const [file, rank] of lexFileRank.entries()) {
    fused.set(file, (fused.get(file) ?? 0) + 1 / (RRF_K + rank));
  }
  semFiles.forEach((sf, i) => {
    fused.set(sf.filePath, (fused.get(sf.filePath) ?? 0) + SEM_RRF_SEM_W / (RRF_K + i + 1));
  });

  // 按融合后的文件序输出节点。⚠️ 每文件限额 SEM_NODES_PER_FILE：若整文件倾倒，
  // 前几个文件就会吃光 maxResults 个坑，把后面文件（含正确命中）整体挤出输出——
  // RRF 第一版实测 4 条翻负皆因此坑位垄断，而非融合公式本身。
  const out: GraphNode[] = [];
  const orderedFiles = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  for (const file of orderedFiles) {
    const nodes = nodesByFile.get(file) ?? (fileNodeMap.get(file) ?? [])
      .slice()
      .sort((a, b) => (NODE_TYPE_SCORE[b.type] ?? 0) - (NODE_TYPE_SCORE[a.type] ?? 0));
    for (const node of nodes.slice(0, SEM_NODES_PER_FILE)) {
      out.push(node);
      if (out.length >= maxResults) return out;
    }
  }
  return out;
}


export function mergeNodesByOrder(...groups: GraphNode[][]): GraphNode[] {
  return Array.from(
    new Map(groups.flat().map((node) => [node.id, node])).values()
  );
}


export function prioritizeNodesByFileScope(nodes: GraphNode[], scopeFiles: string[]): GraphNode[] {
  if (scopeFiles.length === 0) return nodes;
  const fileSet = new Set(scopeFiles);
  const inScope = nodes.filter((node) => fileSet.has(node.filePath));
  if (inScope.length === 0) return nodes;
  const outScope = nodes.filter((node) => !fileSet.has(node.filePath));
  return [...inScope, ...outScope];
}


export function recallFacts(question: string, plan: QuestionPlan, scopeFiles: string[] = [], maxFacts: number = 40): Array<CodeFact & { score: number }> {
  if (!factIndex?.facts?.length) return [];
  const coreTerms = Array.from(new Set([...extractQuestionCoreTerms(question), ...extractSearchTerms(question, plan.keywords).slice(0, 10)]));
  if (coreTerms.length === 0) return [];

  const scopeSet = new Set(scopeFiles);
  const concernKindBoost: Partial<Record<PlanConcern, Partial<Record<FactKind, number>>>> = {
    ui_condition: { condition: 3, trigger: 2 }, data_flow: { trigger: 3, api: 2, state: 2 }, state_flow: { state: 3, condition: 2 },
    api_list: { api: 4, trigger: 1 }, pagination: { condition: 1, state: 2, api: 1 }, component_relation: { trigger: 2, condition: 2, state: 1 },
  };

  const scored: Array<CodeFact & { score: number }> = [];
  for (const fact of factIndex.facts) {
    let termHits = 0;
    for (const term of coreTerms) { if (fact.terms.includes(term) || fact.text.toLowerCase().includes(term)) termHits++; }
    if (termHits === 0) continue;
    let score = termHits * 3 + (concernKindBoost[plan.concern]?.[fact.kind] ?? 0);
    if (scopeSet.has(fact.filePath)) score += 2;
    if (fact.context && coreTerms.some((term) => fact.context!.toLowerCase().includes(term))) score += 2;
    if (score < 5) continue;
    scored.push({ ...fact, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxFacts);
}


export function collectNodesFromFacts(facts: Array<CodeFact & { score: number }>, maxNodes: number = 45): GraphNode[] {
  if (facts.length === 0) return [];
  const rankedNodes: Array<{ node: GraphNode; score: number }> = [];
  for (const fact of facts) {
    const nodesInFile = fileNodeMap.get(fact.filePath) ?? [];
    if (nodesInFile.length === 0) continue;
    const nearby = nodesInFile.map((node) => {
      const distance = Math.abs(parseLine(node.loc) - fact.line);
      const score = fact.score + Math.max(0, 8 - Math.min(distance, 8));
      return { node, score };
    }).sort((a, b) => b.score - a.score).slice(0, 3);
    rankedNodes.push(...nearby);
  }
  return Array.from(new Map(rankedNodes.sort((a, b) => b.score - a.score).slice(0, maxNodes * 2).map((item) => [item.node.id, item.node])).values()).slice(0, maxNodes);
}


export function collectActionMethodHints(
  question: string,
  scopeFiles: string[] = [],
  scopeDir?: string
): Map<string, number> {
  const hints = new Map<string, number>();
  if (!factIndex?.facts?.length) return hints;

  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const questionTerms = extractQuestionCoreTerms(question);
  const scopeSet = new Set(scopeFiles);
  const questionLower = question.toLowerCase();

  for (const fact of factIndex.facts) {
    if (fact.kind !== 'trigger' && fact.kind !== 'logic') continue;

    const combined = `${fact.context ?? ''} ${fact.text}`;
    if (!/(action:|handleClick|onClick|@click|openDialog|inventoryCheck|batchInventoryCheck)/i.test(combined)) continue;
    if (scopeDir) {
      if (!fact.filePath.startsWith(scopeDir)) continue;
    } else if (scopeSet.size > 0 && !scopeSet.has(fact.filePath)) {
      continue;
    }

    const lower = combined.toLowerCase();
    if (buttonTerms.length > 0 && !buttonTerms.some((term) => lower.includes(term)) && (fact.context ?? '').startsWith('action:')) {
      continue;
    }

    const methods = extractMethodNamesFromEventLine(combined);
    for (const method of methods) {
      const methodLower = method.toLowerCase();
      let score = 3;
      if (/(open|confirm|submit|verify|check|batch|void|discard|abolish|inventory|audit)/i.test(methodLower)) score += 5;
      if (/(核实|校验|确认|verify|check)/i.test(questionLower) && /(verify|check|confirm|inventory|batch)/i.test(methodLower)) score += 8;
      if (/(作废|废弃|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|cancel)/i.test(methodLower)) score += 8;
      if (/(审核|审批|audit|approve)/i.test(questionLower) && /(audit|approve|review)/i.test(methodLower)) score += 8;
      for (const term of questionTerms) {
        if (term.length >= 2 && methodLower.includes(term)) score += 2;
      }
      if (buttonTerms.length > 0 && buttonTerms.some((term) => lower.includes(term))) score += 5;
      hints.set(method, (hints.get(method) ?? 0) + score);
    }
  }

  return hints;
}
