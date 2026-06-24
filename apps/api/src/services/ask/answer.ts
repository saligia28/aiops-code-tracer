// ============================================================
// 问题规划 & 上下文组装 & 答案合成
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import type {
  GraphNode,
  GraphEdge,
  Evidence,
  IntentType,
} from '@aiops/shared-types';
import {
  currentRepoPath,
  type PageAnchor,
  type PlanConcern,
  type EvidenceNeed,
  type QuestionPlan,
  type CodeLocation,
} from '../../context.js';
import { callChatCompletion, canUseLlm } from '../llmService.js';
import { parseLine, estimateTokens, escapeRegex, NODE_TYPE_SCORE, tokenizeForRecall } from './textUtils.js';
import { findFunctionBoundary } from './codeScan.js';
import { isApiListQuestion, isPaginationQuestion, isComponentFeatureQuestion, isFlowQuestion, isPageStructureQuestion, isUiConditionQuestion, extractPagePhrase, extractLikelyScope, extractQuestionCoreTerms } from './questionAnalysis.js';
import { tryAnalyzeApiPassThrough } from './endpoints.js';


function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function toConcern(value: unknown): PlanConcern {
  const str = String(value ?? '').toLowerCase();
  const allowed: PlanConcern[] = [
    'api_list', 'ui_condition', 'pagination', 'data_flow', 'state_flow',
    'component_relation', 'error_trace', 'general',
  ];
  return allowed.includes(str as PlanConcern) ? (str as PlanConcern) : 'general';
}


function toEvidenceNeeds(input: unknown): EvidenceNeed[] {
  if (!Array.isArray(input)) return [];
  const allowed: EvidenceNeed[] = ['api', 'condition', 'function', 'state', 'route', 'pagination', 'component'];
  const values = input
    .map((item) => String(item ?? '').toLowerCase())
    .filter((item): item is EvidenceNeed => allowed.includes(item as EvidenceNeed));
  return Array.from(new Set(values));
}


export function heuristicQuestionPlan(question: string): QuestionPlan {
  const q = question.trim();
  const keywords = tokenizeForRecall(q).slice(0, 12);

  if (isApiListQuestion(q)) {
    return { concern: 'api_list', scope: extractPagePhrase(q) ?? extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['api', 'route'], intentHint: 'API_USAGE' };
  }
  if (isPaginationQuestion(q)) {
    return { concern: 'pagination', scope: extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['pagination', 'function', 'api'], intentHint: 'DATA_SOURCE' };
  }
  if (isComponentFeatureQuestion(q)) {
    return { concern: 'component_relation', scope: extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['component', 'function', 'condition', 'api'], intentHint: 'COMPONENT_RELATION' };
  }
  if (isFlowQuestion(q)) {
    return { concern: 'data_flow', scope: extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['function', 'condition', 'api', 'component'], intentHint: 'CLICK_FLOW' };
  }
  if (isPageStructureQuestion(q)) {
    return { concern: 'general', scope: extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['component', 'condition', 'function'], intentHint: 'PAGE_STRUCTURE' };
  }
  if (isUiConditionQuestion(q)) {
    return { concern: 'ui_condition', scope: extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['condition', 'function'], intentHint: 'UI_CONDITION' };
  }

  return { concern: 'general', scope: extractPagePhrase(q) ?? extractLikelyScope(q) ?? undefined, keywords, mustEvidence: ['function', 'api'] };
}


export async function generateQuestionPlan(question: string): Promise<QuestionPlan> {
  const fallback = heuristicQuestionPlan(question);
  if (!canUseLlm()) return fallback;
  if (fallback.concern !== 'general') return fallback;

  const prompt = [
    '你是问题规划器。请将用户问题转成检索计划，输出 JSON。',
    '字段：concern, scope, keywords, mustEvidence',
    'concern 枚举：api_list|ui_condition|pagination|data_flow|state_flow|component_relation|error_trace|general',
    'mustEvidence 枚举：api|condition|function|state|route|pagination|component',
    '只输出 JSON，不要解释。',
    `问题：${question}`,
  ].join('\n');

  const content = await callChatCompletion([{ role: 'user', content: prompt }]);
  if (!content) return fallback;

  const json = parseJsonObject(content);
  if (!json) return fallback;

  const keywords = Array.isArray(json.keywords)
    ? json.keywords.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 20)
    : fallback.keywords;
  const llmConcern = toConcern(json.concern);
  const llmNeeds = toEvidenceNeeds(json.mustEvidence);
  const mergedConcern = fallback.concern !== 'general' ? fallback.concern : llmConcern;
  const mergedKeywords = Array.from(new Set([...fallback.keywords, ...keywords])).slice(0, 24);
  const mergedNeeds = Array.from(new Set([...(fallback.mustEvidence ?? []), ...llmNeeds]));

  return {
    concern: mergedConcern,
    scope: fallback.scope || (typeof json.scope === 'string' && json.scope.trim() ? json.scope.trim() : undefined),
    keywords: mergedKeywords.length > 0 ? mergedKeywords : fallback.keywords,
    mustEvidence: mergedNeeds.length > 0 ? mergedNeeds : fallback.mustEvidence,
    intentHint: fallback.intentHint,
  };
}


export function buildFollowUps(question: string, topNodes: GraphNode[], plan?: QuestionPlan): string[] {
  if (topNodes.length === 0) {
    return [
      '可以给我一个更具体的符号名吗？例如 pageSize、currentPage、fetchList',
      '这个功能在哪个页面或模块？',
      '你更关心点击入口、接口参数，还是状态更新？',
    ];
  }

  const coreTerms = extractQuestionCoreTerms(question);
  const rankedTop = topNodes
    .map((node) => {
      const text = `${node.name} ${node.filePath}`.toLowerCase();
      let score = NODE_TYPE_SCORE[node.type] ?? 0;
      for (const term of coreTerms) {
        if (term.length >= 2 && text.includes(term)) score += 3;
      }
      if (/^(data|get|set|created|mounted|setup|init|userInfo)$/i.test(node.name)) score -= 5;
      if (/(inventoryCheck|batchInventoryCheck|verify|check|confirm|audit|page|pagination)/i.test(node.name)) score += 3;
      return { node, score };
    })
    .sort((a, b) => b.score - a.score);
  const first = rankedTop[0]?.node ?? topNodes[0];
  const concern = plan?.concern ?? 'general';
  const focusPrompt = concern === 'pagination'
    ? `"${first.filePath}"里分页参数（page/pageSize）如何传递？`
    : concern === 'ui_condition'
      ? `"${first.filePath}"里按钮显示条件（v-if/权限判断）写在哪？`
      : concern === 'api_list'
        ? `"${first.filePath}"涉及哪些后端接口调用？`
        : concern === 'component_relation'
          ? `"${first.filePath}"这个组件具体由哪些 props / 事件驱动？`
          : `和"${question}"相关的状态变量在哪些地方被修改？`;
  const suggestions = [
    `"${first.name}"的上游触发链路是什么？`,
    `"${first.name}"最终调用了哪些接口？`,
    focusPrompt,
  ];
  return Array.from(new Set(suggestions)).slice(0, 3);
}


export function composeAnswer(question: string, intent: IntentType, nodes: GraphNode[], graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  if (nodes.length === 0) {
    return [
      `结论：我还没在当前索引里定位到"${question}"的直接实现。`,
      '建议你补一个更具体的关键词（例如 pageNum/pageSize、接口名、组件名），我可以直接给到更接近业务语言的解释。',
    ].join('\n');
  }

  const top = nodes.slice(0, 5);
  const topText = top
    .map((node, idx) => `${idx + 1}. ${node.filePath}:${parseLine(node.loc)}（${node.name}）`)
    .join('\n');

  const intentLabel: Record<IntentType, string> = {
    UI_CONDITION: 'UI 展示条件',
    CLICK_FLOW: '点击触发流程',
    DATA_SOURCE: '数据来源',
    API_USAGE: '接口调用',
    STATE_FLOW: '状态流转',
    COMPONENT_RELATION: '组件关系',
    PAGE_STRUCTURE: '页面结构',
    ERROR_TRACE: '错误链路',
    GENERAL: '通用查询',
  };

  const first = top[0];
  const passThroughInfo = isPaginationQuestion(question) ? tryAnalyzeApiPassThrough(first) : null;
  if (isPaginationQuestion(question) && passThroughInfo?.paramName) {
    const endpointText = passThroughInfo.endpoint ? `，接口是 ${passThroughInfo.endpoint}` : '';
    return [
      '结论：这个位置主要是"转发参数到后端接口"，不是分页规则本体。',
      `白话解释：在 ${first.filePath}:${parseLine(first.loc)} 的 ${first.name} 里，函数把调用方传进来的 ${passThroughInfo.paramName} 直接发给后端${endpointText}。`,
      '这意味着页码/每页条数通常在页面或表格组件里先组装好（如 pageNum/pageSize），然后整体传入这个 API 方法。',
      '',
      '我建议你优先看这几处：',
      topText,
      '',
      `当前定位到的关联链路：${graph.nodes.length} 个节点，${graph.edges.length} 条边。`,
    ].join('\n');
  }

  return [
    `结论：我已定位到这个问题最可能的实现入口（${intentLabel[intent]}）。`,
    `白话解释：先从 ${first.filePath}:${parseLine(first.loc)} 的 ${first.name} 开始看，它是当前链路里最核心的入口。`,
    '',
    '相关代码位置：',
    topText,
    '',
    `当前定位到的关联链路：${graph.nodes.length} 个节点，${graph.edges.length} 条边。`,
  ].join('\n');
}


export function getCodeSnippet(filePath: string, line: number): string {
  if (!currentRepoPath) return '  - 代码片段不可用';
  const absPath = path.join(currentRepoPath, filePath);
  if (!fs.existsSync(absPath)) return '  - 代码片段不可用';
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    const { start, end } = findFunctionBoundary(lines, line, 20);
    const rows: string[] = [];
    for (let i = start; i <= end; i++) {
      const text = (lines[i] ?? '').trimEnd();
      if (!text.trim()) continue;
      rows.push(`  L${i + 1}: ${text}`);
    }
    return rows.length > 0 ? rows.join('\n') : '  - 代码片段不可用';
  } catch {
    return '  - 代码片段不可用';
  }
}


export function buildEvidenceContext(evidence: Evidence[]): string {
  if (evidence.length === 0) return '无';
  return evidence
    .slice(0, 6)
    .map((item, idx) => {
      const snippet = getCodeSnippet(item.file, item.line);
      return `${idx + 1}. ${item.file}:${item.line} | ${item.label}\n${snippet}`;
    })
    .join('\n');
}


export function buildEvidenceHints(evidence: Evidence[], codeContext: string, tokenBudget: number): string {
  if (evidence.length === 0) return '无';

  const items = evidence.slice(0, 8);
  const hints: string[] = [];
  let usedTokens = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const lineMarker = `L${item.line}:`;
    const fileMarker = `--- ${item.file} ---`;
    const alreadyCovered = codeContext.includes(fileMarker) && codeContext.includes(lineMarker);

    let hint: string;
    if (alreadyCovered) {
      hint = `${idx + 1}. [${item.label}] ${item.file}:${item.line}（已在代码片段中）`;
    } else {
      const snippet = getCodeSnippet(item.file, item.line);
      hint = `${idx + 1}. [${item.label}] ${item.file}:${item.line}\n${snippet}`;
    }

    const hintTokens = estimateTokens(hint);
    if (usedTokens + hintTokens > tokenBudget) break;
    usedTokens += hintTokens;
    hints.push(hint);
  }

  return hints.length > 0 ? hints.join('\n') : '无';
}


export function buildGraphContext(graph: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  if (graph.nodes.length === 0 || graph.edges.length === 0) return '无';
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return graph.edges.slice(0, 15).map((edge, idx) => {
    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    const fromText = fromNode ? `${fromNode.name}(${fromNode.filePath}:${parseLine(fromNode.loc)})` : edge.from;
    const toText = toNode ? `${toNode.name}(${toNode.filePath}:${parseLine(toNode.loc)})` : edge.to;
    return `${idx + 1}. ${fromText} --${edge.type}--> ${toText}`;
  }).join('\n');
}


function collectCodeLocations(
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  maxLocations: number = 15
): CodeLocation[] {
  const seen = new Set<string>();
  const locations: CodeLocation[] = [];

  const addLoc = (filePath: string, line: number, priority: number, label: string) => {
    const key = `${filePath}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({ filePath, line, priority, label });
  };

  for (let i = 0; i < Math.min(5, nodes.length); i++) {
    const node = nodes[i];
    if (node.type === 'file' || node.type === 'import') continue;
    addLoc(node.filePath, parseLine(node.loc), 100 - i * 10, `top-${i + 1}: ${node.name}`);
  }

  const graphNodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges.slice(0, 20)) {
    const fromNode = graphNodeMap.get(edge.from);
    const toNode = graphNodeMap.get(edge.to);
    if (fromNode && fromNode.type !== 'file' && fromNode.type !== 'import') {
      addLoc(fromNode.filePath, parseLine(fromNode.loc), 50, `chain-from: ${fromNode.name}`);
    }
    if (toNode && toNode.type !== 'file' && toNode.type !== 'import') {
      addLoc(toNode.filePath, parseLine(toNode.loc), 50, `chain-to: ${toNode.name}`);
    }
  }

  for (const node of nodes.slice(5, 15)) {
    if (node.type === 'file' || node.type === 'import') continue;
    addLoc(node.filePath, parseLine(node.loc), 30, `related: ${node.name}`);
  }

  return locations
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxLocations);
}


function truncateToTokenLimit(context: string, maxTokens: number): string {
  if (estimateTokens(context) <= maxTokens) return context;

  const fileBlocks = context.split(/\n---\s/);
  let result = '';
  for (const block of fileBlocks) {
    const prefix = result ? `\n--- ` : '';
    const candidate = result + prefix + block;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result || context.slice(0, maxTokens * 3);
}


export function assembleCodeContext(
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  maxTokens: number = 6000
): string {
  if (!currentRepoPath) return '';

  const fileSnippets = new Map<string, string[]>();
  const locations = collectCodeLocations(nodes, graph);

  for (const loc of locations) {
    const absPath = path.join(currentRepoPath, loc.filePath);
    if (!fs.existsSync(absPath)) continue;

    let lines: string[];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split('\n');
    } catch {
      continue;
    }

    const { start, end } = findFunctionBoundary(lines, loc.line);
    const snippet = lines.slice(start, end + 1)
      .map((line, i) => `L${start + i + 1}: ${line}`)
      .join('\n');

    const existing = fileSnippets.get(loc.filePath) ?? [];
    const isDuplicate = existing.some((s) => {
      const firstLine = s.match(/^L(\d+):/);
      const lastLineMatch = s.match(/\nL(\d+):[^\n]*$/);
      if (!firstLine) return false;
      const existStart = parseInt(firstLine[1]);
      const existEnd = lastLineMatch ? parseInt(lastLineMatch[1]) : existStart;
      return start + 1 >= existStart && end + 1 <= existEnd;
    });
    if (!isDuplicate) {
      existing.push(snippet);
      fileSnippets.set(loc.filePath, existing);
    }
  }

  let context = '';
  for (const [file, snippets] of fileSnippets) {
    context += `\n--- ${file} ---\n`;
    context += snippets.join('\n...\n');
    context += '\n';
  }

  return truncateToTokenLimit(context, maxTokens);
}


export function extractEvidenceFromAnswer(answer: string, codeContext: string): Evidence[] {
  const refs = answer.matchAll(/([^\s:：]+\.(vue|ts|js|tsx|jsx)):(\d+)/g);
  const evidence: Evidence[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    const rawFile = ref[1];
    const file = rawFile.replace(/^[`"'(<\[]+|[`"')>\],.;:]+$/g, '');
    if (!/\.(vue|ts|js|tsx|jsx)$/i.test(file)) continue;
    const line = parseInt(ref[3]);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let code = '';
    const blockPattern = new RegExp(`---\\s+${escapeRegex(file)}\\s+---([\\s\\S]*?)(?:\\n---\\s|$)`);
    const blockMatch = codeContext.match(blockPattern);
    if (blockMatch?.[1]) {
      const linePattern = new RegExp(`^L${line}:\\s*(.+)$`, 'm');
      const lineMatch = blockMatch[1].match(linePattern);
      if (lineMatch?.[1]) {
        code = lineMatch[1].trim();
      }
    }

    evidence.push({
      file,
      line,
      code: code || `(见 ${file}:${line})`,
      label: '关键代码',
    });
  }

  return evidence.slice(0, 12);
}


export async function composeAnswerWithLlm(
  question: string,
  intent: IntentType,
  nodes: GraphNode[],
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  evidence: Evidence[],
  plan: QuestionPlan,
  anchor: PageAnchor | null
): Promise<string> {
  const fallback = composeAnswer(question, intent, nodes, graph);
  if (!canUseLlm()) return fallback;

  const systemPrompt = [
    '你是代码库问答助手。你必须只基于给定证据回答，禁止编造。',
    '如果证据里没有明确条件（例如 auditStatus、v-if），必须写"证据不足，未定位到明确条件"。',
    '禁止补充任何未在证据中出现的状态值、角色权限、接口参数名。',
    '如果问题涉及页面中的组件能力，优先按"页面入口 -> 引用组件 -> 组件内部函数/条件 -> 接口"组织说明。',
    '回答时默认按"条件 -> 触发 -> 状态变化 -> 接口调用"四段逻辑梳理；若某段缺失，明确说明缺失段证据不足。',
    '输出要求：',
    '1) 第一段必须是"结论：..."白话结论',
    '2) 第二段给"实现说明：..."描述条件、触发和数据流',
    '3) 第三段给"相关代码："并列出 3-8 条 文件:行号 + 作用',
    '4) 语言要面向业务同学，避免术语堆砌',
    '4.1) 如需提到函数名/变量名，后面必须补一句白话作用，不能只给代码名词。',
    '5) 如果问题是"页面用了哪些接口"，按"接口清单"逐条列出 METHOD + endpoint',
  ].join('\n');

  const userPrompt = [
    `问题：${question}`,
    `识别意图：${intent}`,
    `问题关注点：${plan.concern}`,
    `页面范围：${plan.scope ?? anchor?.title ?? '未指定'}`,
    `关键词：${plan.keywords.join(', ') || '无'}`,
    `必需证据：${plan.mustEvidence.join(', ') || '无'}`,
    '',
    '证据列表：',
    buildEvidenceContext(evidence),
    '',
    '图谱链路：',
    buildGraphContext(graph),
    '',
    '请严格基于以上证据作答。',
  ].join('\n');

  const llmAnswer = await callChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return llmAnswer || fallback;
}
