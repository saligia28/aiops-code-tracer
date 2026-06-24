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


export function findRelevantNodes(question: string, maxResults: number = 40, plan?: QuestionPlan): GraphNode[] {
  if (!graphStore) return [];
  const scopeTerms = tokenizeForRecall(plan?.scope ?? '').slice(0, 8);
  const terms = extractSearchTerms(question, [...(plan?.keywords ?? []), ...scopeTerms]);
  const scored = new Map<string, { node: GraphNode; score: number }>();

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

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.node);
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
