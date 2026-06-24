// ============================================================
// 图路径 / 追踪图 / 起点选择
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import path from 'path';
import type {
  GraphNode,
  GraphEdge,
  Evidence,
  IntentType,
} from '@aiops/shared-types';
import {
  graphStore,
  type PageAnchor,
  type PlanConcern,
  type QuestionPlan,
} from '../../context.js';
import { NODE_TYPE_SCORE, parseLine, tokenizeForRecall } from './textUtils.js';
import { extractQuestionCoreTerms, extractButtonLabelKeywords, extractSearchTerms, isFlowQuestion, isPaginationQuestion, isUiConditionQuestion } from './questionAnalysis.js';
import { collectActionMethodHints, prioritizeNodesByFileScope } from './recall.js';


export function pickTraceGraph(
  startNode: GraphNode,
  intent: IntentType,
  question: string,
  concern: PlanConcern = 'general'
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!graphStore) return { nodes: [], edges: [] };

  const forward = graphStore.traceForward(startNode.id, 2);
  const backward = graphStore.traceBackward(startNode.id, 2);

  const preferBackward = intent === 'DATA_SOURCE'
    || intent === 'ERROR_TRACE'
    || intent === 'UI_CONDITION'
    || concern === 'data_flow'
    || concern === 'ui_condition'
    || concern === 'pagination'
    || isPaginationQuestion(question)
    || isUiConditionQuestion(question);
  const selected = preferBackward ? backward : forward;
  const fallback = selected.nodes.length > 1 ? selected : (forward.nodes.length >= backward.nodes.length ? forward : backward);

  return {
    nodes: fallback.nodes.slice(0, 180),
    edges: fallback.edges.slice(0, 260),
  };
}


const FLOW_PATH_EDGE_TYPES = new Set<GraphEdge['type']>([
  'calls',
  'dispatches',
  'commits',
  'bindsEvent',
  'guardsBy',
  'uses',
  'assigns',
  'defines',
  // Java 主链：routeEntry -registersRoute-> handler -...-> field -injects-> 实现
  'injects',
  'registersRoute',
  // 接口↔实现对问答有价值；extends 继承链噪声大，暂不纳入
  'implements',
]);


function rankApiTargetNodes(
  question: string,
  anchor: PageAnchor | null,
  componentFiles: string[] = [],
  maxTargets: number = 12
): Array<{ node: GraphNode; score: number }> {
  if (!graphStore) return [];

  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const componentFileSet = new Set(componentFiles);
  const terms = extractQuestionCoreTerms(question);
  const questionLower = question.toLowerCase();
  const askVerify = /(核实|校验|verify|check)/i.test(questionLower);
  const askVoid = /(作废|废弃|void|discard|abolish)/i.test(questionLower);
  const askAudit = /(审核|审批|audit|approve)/i.test(questionLower);

  return graphStore.getAllNodes()
    .filter((node) => node.type === 'apiCall')
    .map((node) => {
      const endpoint = node.meta?.apiEndpoint ?? '';
      const haystack = `${node.name} ${node.filePath} ${endpoint}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 14;
      if (componentFileSet.has(node.filePath)) score += 8;
      for (const term of terms) {
        if (term.length >= 2 && haystack.includes(term)) score += 2;
      }
      if (askVerify) {
        if (/(verify|check|核实|\/verify(?:\/|$))/i.test(haystack)) score += 12;
        else score -= 8;
        if (/todo\/confirm|batch\/todo\/confirm/i.test(haystack)) score -= 5;
      }
      if (askVoid && /(void|discard|abolish|作废)/i.test(haystack)) score += 10;
      if (askAudit && /(audit|approve|review|审批|审核)/i.test(haystack)) score += 8;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTargets);
}


function findShortestGraphPath(
  startId: string,
  targetIds: Set<string>,
  maxDepth: number = 7
): GraphEdge[] | null {
  if (!graphStore || targetIds.size === 0) return null;

  const queue: Array<{ nodeId: string; depth: number; path: GraphEdge[] }> = [
    { nodeId: startId, depth: 0, path: [] },
  ];
  const bestDepth = new Map<string, number>([[startId, 0]]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > maxDepth) continue;
    if (targetIds.has(current.nodeId) && current.path.length > 0) {
      return current.path;
    }

    for (const edge of graphStore.getOutEdges(current.nodeId)) {
      if (!FLOW_PATH_EDGE_TYPES.has(edge.type)) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth > maxDepth) continue;
      const prevDepth = bestDepth.get(edge.to);
      if (prevDepth !== undefined && prevDepth <= nextDepth) continue;
      bestDepth.set(edge.to, nextDepth);
      queue.push({
        nodeId: edge.to,
        depth: nextDepth,
        path: [...current.path, edge],
      });
    }
  }

  return null;
}


export function buildGraphPathEvidence(
  question: string,
  nodes: GraphNode[],
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!graphStore || nodes.length === 0 || maxEvidence <= 0) return [];
  if (!(plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation' || isFlowQuestion(question))) {
    return [];
  }

  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const componentFileSet = new Set(componentFiles);
  const questionTerms = extractQuestionCoreTerms(question);
  const actionHints = collectActionMethodHints(question, componentFiles, scopeDir || undefined);
  const apiTargets = rankApiTargetNodes(question, anchor, componentFiles, 12);
  if (apiTargets.length === 0) return [];
  const targetScoreMap = new Map(apiTargets.map((item) => [item.node.id, item.score]));

  const hintedGraphNodes = graphStore.getAllNodes().filter((node) => {
    if (node.type === 'file' || node.type === 'import' || node.type === 'apiCall') return false;
    if (scopeDir && !node.filePath.startsWith(scopeDir)) return false;
    if (componentFileSet.size > 0 && !componentFileSet.has(node.filePath) && !scopeDir) return false;
    if (actionHints.has(node.name)) return true;
    return /(inventorycheck|batchinventorycheck|confirmdata|batchverify|verify|check|confirm|opendialog)/i.test(node.name);
  });

  const candidateNodeMap = new Map<string, GraphNode>([
    ...nodes.filter((node) => node.type !== 'file' && node.type !== 'import').map((node) => [node.id, node] as const),
    ...hintedGraphNodes.map((node) => [node.id, node] as const),
  ]);

  const startCandidates = Array.from(candidateNodeMap.values())
    .filter((node) => node.type !== 'file' && node.type !== 'import')
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 8;
      if (componentFileSet.has(node.filePath)) score += 6;
      if (actionHints.has(node.name)) score += 10 + (actionHints.get(node.name) ?? 0);
      if (/(inventorycheck|batchinventorycheck|confirmdata|verify|check|confirm|open|submit|handle)/i.test(node.name)) score += 4;
      if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 6;
      for (const term of questionTerms) {
        if (term.length >= 2 && text.includes(term)) score += 2;
      }
      return { node, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 14);

  const pathCandidates: Array<{ start: GraphNode; target: GraphNode; path: GraphEdge[]; score: number }> = [];
  for (const candidate of startCandidates) {
    for (const target of apiTargets.slice(0, 8)) {
      const pathEdges = findShortestGraphPath(candidate.node.id, new Set([target.node.id]), 8);
      if (!pathEdges || pathEdges.length === 0) continue;
      const chainScore = candidate.score + (targetScoreMap.get(target.node.id) ?? 0) + Math.max(0, 18 - pathEdges.length * 2);
      pathCandidates.push({
        start: candidate.node,
        target: target.node,
        path: pathEdges,
        score: chainScore,
      });
    }
  }

  if (pathCandidates.length === 0) return [];

  const wantMultiPath = /完整|全链路|完整链路|完整流程|闭环|全流程/.test(question);
  const selectedPaths: Array<{ start: GraphNode; target: GraphNode; path: GraphEdge[]; score: number }> = [];
  const usedTargets = new Set<string>();
  for (const candidate of pathCandidates.sort((a, b) => b.score - a.score)) {
    if (usedTargets.has(candidate.target.id)) continue;
    selectedPaths.push(candidate);
    usedTargets.add(candidate.target.id);
    if (selectedPaths.length >= (wantMultiPath ? 2 : 1)) break;
  }
  if (selectedPaths.length === 0) return [];

  const nodeById = new Map<string, GraphNode>(graphStore.getAllNodes().map((node) => [node.id, node]));
  const evidence: Evidence[] = [];
  const appendedStarts = new Set<string>();

  for (const selected of selectedPaths) {
    if (!appendedStarts.has(selected.start.id)) {
      evidence.push({
        file: selected.start.filePath,
        line: parseLine(selected.start.loc),
        code: `入口函数 ${selected.start.name}`,
        label: '链路起点',
      });
      appendedStarts.add(selected.start.id);
    }

    for (const edge of selected.path) {
      const fromNode = nodeById.get(edge.from);
      const toNode = nodeById.get(edge.to);
      if (!toNode) continue;
      if (scopeDir && !toNode.filePath.startsWith(scopeDir) && toNode.type !== 'apiCall') continue;

      if (toNode.type === 'apiCall') {
        evidence.push({
          file: toNode.filePath,
          line: parseLine(toNode.loc),
          code: `${toNode.meta?.apiMethod ?? 'API'} ${toNode.meta?.apiEndpoint ?? toNode.name}`,
          label: '链路接口',
        });
        continue;
      }

      const fromName = fromNode?.name ?? '调用方';
      evidence.push({
        file: toNode.filePath,
        line: parseLine(toNode.loc),
        code: `${fromName} --${edge.type}--> ${toNode.name}`,
        label: edge.type === 'guardsBy' ? '链路条件' : '链路函数',
      });
    }
  }

  return Array.from(
    new Map(evidence.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  ).slice(0, maxEvidence);
}


export function applyAnchorScope(
  nodes: GraphNode[],
  anchor: PageAnchor | null,
  plan?: QuestionPlan,
  componentFiles: string[] = []
): GraphNode[] {
  let ranked = nodes;
  if (componentFiles.length > 0) {
    ranked = prioritizeNodesByFileScope(ranked, componentFiles);
  }

  if (!anchor) return ranked;
  const scopeDir = path.dirname(anchor.componentFile);
  const strong = ranked.filter((node) => node.filePath.startsWith(scopeDir));
  if (strong.length > 0) {
    ranked = [...strong, ...ranked.filter((node) => !node.filePath.startsWith(scopeDir))];
    if (plan?.concern && plan.concern !== 'general' && strong.length >= 8) {
      const scoped = ranked.slice(0, 45);
      return scoped;
    }
    return ranked;
  }

  const scopeTerms = tokenizeForRecall(`${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`);
  const weak = ranked.filter((node) => {
    const text = `${node.filePath} ${node.name}`.toLowerCase();
    return scopeTerms.some((term) => text.includes(term));
  });
  if (weak.length >= 6) {
    return [...weak, ...ranked.filter((node) => !weak.some((item) => item.id === node.id))];
  }
  return ranked;
}


export function selectStartNode(
  question: string,
  nodes: GraphNode[],
  plan?: QuestionPlan,
  componentFiles: string[] = [],
  anchor: PageAnchor | null = null
): GraphNode | undefined {
  if (nodes.length === 0) return undefined;
  const concern = plan?.concern ?? (isPaginationQuestion(question) ? 'pagination' : isUiConditionQuestion(question) ? 'ui_condition' : 'general');
  const componentFileSet = new Set(componentFiles);
  const questionTerms = extractSearchTerms(question);
  const scopeDir = anchor ? path.dirname(anchor.componentFile) : '';
  const actionMethodHints = collectActionMethodHints(question, componentFiles, scopeDir || undefined);

  if (concern === 'component_relation' && componentFileSet.size > 0) {
    const scored = nodes
      .filter((node) => componentFileSet.has(node.filePath))
      .map((node) => {
        const text = `${node.name} ${node.filePath}`.toLowerCase();
        let score = NODE_TYPE_SCORE[node.type] ?? 0;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 4;
        if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 6;
        if (/(component|props|emit|watch|computed|handle|click|open|dialog|table)/i.test(node.name)) score += 4;
        for (const term of questionTerms) {
          if (text.includes(term)) score += 1;
        }
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored[0].node;
  }
  if (concern === 'data_flow' && componentFileSet.size > 0) {
    const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
    const flowTerms = extractQuestionCoreTerms(question);
    const askVerify = /(核实|校验|确认|verify|check)/i.test(question);
    const askVoid = /(作废|废弃|void|discard|abolish)/i.test(question);
    const askAudit = /(审核|审批|audit|approve)/i.test(question);

    const hintedFlowNodes = nodes
      .filter((node) => componentFileSet.has(node.filePath) && actionMethodHints.has(node.name))
      .map((node) => {
        let score = (actionMethodHints.get(node.name) ?? 0) + 12;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 4;
        if (askVerify && /(verify|check|inventory|batch|confirm)/i.test(node.name)) score += 6;
        if (askVoid && /(void|discard|abolish|cancel)/i.test(node.name)) score += 6;
        if (askAudit && /(audit|approve|review)/i.test(node.name)) score += 6;
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (hintedFlowNodes.length > 0) return hintedFlowNodes[0].node;

    const scoredFlowNodes = nodes
      .filter((node) => componentFileSet.has(node.filePath) && node.type !== 'import')
      .map((node) => {
        const text = `${node.name} ${node.filePath}`.toLowerCase();
        let score = NODE_TYPE_SCORE[node.type] ?? 0;
        if (scopeDir && node.filePath.startsWith(scopeDir)) score += 6;
        if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 8;
        if (/(open|confirm|submit|void|discard|verify|batch|handle|click|inventory|check)/i.test(node.name)) score += 5;
        if (/(inventorycheck|batchinventorycheck|verify|check|confirm)/i.test(node.name)) score += 7;
        if (/handlecheckboxchange|data|get|set|created|mounted|setup/i.test(node.name)) score -= 3;
        if (/handle(field|checkbox|year|season|filter|table)/i.test(node.name)) score -= 4;
        if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 8;
        if (askVerify && /(check|verify|inventory|batchinventory)/i.test(node.name)) score += 9;
        if (askVoid && /(void|discard|abolish|cancel)/i.test(node.name)) score += 9;
        if (askAudit && /(audit|approve|review)/i.test(node.name)) score += 9;
        if (askVerify && /(expected|history|report|export)/i.test(node.name)) score -= 5;
        if (askVoid && /(expected|history|report|export)/i.test(node.name)) score -= 4;
        for (const term of buttonTerms) {
          if (term && text.includes(term)) score += 6;
        }
        for (const term of flowTerms) {
          if (term.length >= 2 && text.includes(term)) score += 2;
        }
        return { node, score };
      })
      .sort((a, b) => b.score - a.score);
    if (scoredFlowNodes.length > 0) return scoredFlowNodes[0].node;
  }

  if (concern === 'pagination') {
    const paginationNode = nodes.find((node) =>
      /(page|pagination|yltable|fetchtabledata|gettabledata|currentpage|pagesize|pagenum)/i.test(node.name)
    );
    if (paginationNode) return paginationNode;
  }
  if (concern === 'ui_condition') {
    const uiCandidates = componentFileSet.size > 0
      ? nodes.filter((node) => componentFileSet.has(node.filePath))
      : nodes;
    const uiNode = uiCandidates.find((node) =>
      /(abolish|discard|audit|status|visible|show|button|handle)/i.test(node.name)
    ) ?? nodes.find((node) => /(abolish|discard|audit|status|visible|show|button|handle)/i.test(node.name));
    if (uiNode) return uiNode;
  }
  if (concern === 'api_list') {
    const apiCandidates = componentFileSet.size > 0
      ? nodes.filter((node) => componentFileSet.has(node.filePath))
      : nodes;
    const hintedApiStart = apiCandidates
      .filter((node) => actionMethodHints.has(node.name))
      .sort((a, b) => (actionMethodHints.get(b.name) ?? 0) - (actionMethodHints.get(a.name) ?? 0))[0];
    if (hintedApiStart) return hintedApiStart;

    const directApiNode = apiCandidates.find((node) => node.type === 'apiCall')
      ?? nodes.find((node) => node.type === 'apiCall');
    if (directApiNode) return directApiNode;

    let apiNode = apiCandidates.find((node) => /verify|check|confirm|inventory|api|request|post|get/i.test(node.name))
      ?? nodes.find((node) => /verify|check|confirm|inventory|api|request|post|get/i.test(node.name));
    if (!apiNode && graphStore) {
      const scopedGraphApiNode = graphStore.getAllNodes().find((node) =>
        node.type === 'apiCall' && (!scopeDir || node.filePath.startsWith(scopeDir))
      );
      if (scopedGraphApiNode) {
        apiNode = nodes.find((node) => node.id === scopedGraphApiNode.id) ?? scopedGraphApiNode;
      }
    }
    if (apiNode) return apiNode;
  }

  const fallback = nodes
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      if (scopeDir && node.filePath.startsWith(scopeDir)) score += 5;
      if (actionMethodHints.has(node.name)) score += (actionMethodHints.get(node.name) ?? 0) + 6;
      if (/^(getSource|getData|getList|init|setup|created|mounted)$/i.test(node.name)) score -= 5;
      for (const term of questionTerms) {
        if (term.length >= 2 && text.includes(term)) score += 1;
      }
      return { node, score };
    })
    .sort((a, b) => b.score - a.score);

  return fallback[0]?.node ?? nodes[0];
}
