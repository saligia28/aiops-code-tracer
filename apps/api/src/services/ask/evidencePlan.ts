// ============================================================
// 证据打分 / 兜底 / 计划编排
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import type {
  GraphNode,
  Evidence,
} from '@aiops/shared-types';
import {
  currentRepoPath,
  factIndex,
  type CodeFact,
  type PageAnchor,
  type EvidenceNeed,
  type QuestionPlan,
} from '../../context.js';
import { parseLine } from './textUtils.js';
import { hasApiSignal, listFilesRecursively, toRepoRelative } from './codeScan.js';
import { extractQuestionCoreTerms, extractButtonLabelKeywords, extractSearchTerms, isUiConditionQuestion, isComponentFeatureQuestion, isFlowQuestion } from './questionAnalysis.js';
import { findRelevantNodes, recallFacts } from './recall.js';
import { pickHintedComponentFiles } from './componentScope.js';
import { buildGraphPathEvidence } from './graphPath.js';
import { collectPageEndpointHits } from './endpoints.js';
import { buildEvidence, buildGenericEvidence, buildUiConditionEvidence, buildPaginationEvidence, buildActionBlockEvidence, buildFlowChainEvidence, buildComponentEvidence, enrichEvidenceWithButtonConditions } from './evidence.js';


export function scoreEvidenceItem(
  item: Evidence,
  question: string,
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[]
): number {
  const coreTerms = extractQuestionCoreTerms(question);
  const buttonTerms = extractButtonLabelKeywords(question);
  const haystack = `${item.file} ${item.label} ${item.code}`.toLowerCase();
  let score = 0;

  for (const term of coreTerms) {
    if (term.length >= 2 && haystack.includes(term)) score += 2;
  }
  for (const term of buttonTerms) {
    if (term && haystack.includes(term.toLowerCase())) score += 4;
  }
  if (plan.concern === 'ui_condition' && buttonTerms.length > 0) {
    const hasButtonTerm = buttonTerms.some((term) => haystack.includes(term.toLowerCase()));
    if (!hasButtonTerm) {
      score -= 4;
      if (anchor && item.file === anchor.componentFile) score += 2;
    }
  }

  if (anchor) {
    const scopeDir = path.dirname(anchor.componentFile);
    if (item.file.startsWith(scopeDir)) score += 6;
    else if (plan.concern !== 'general') score -= 2;
  }
  if (componentFiles.includes(item.file)) score += 3;

  if (plan.concern === 'ui_condition' && /条件|visible|disabled|v-if|v-show/i.test(`${item.label} ${item.code}`)) score += 4;
  if (plan.concern === 'data_flow' && /触发|handle|click|confirm|submit|open/i.test(`${item.label} ${item.code}`)) score += 3;
  if (plan.concern === 'api_list' && (/apiCall/i.test(item.label) || hasApiSignal(item.code))) score += 4;
  if (/补充接口证据/i.test(item.label)) score += 20;
  else if (/链路接口|动作接口|apiCall|通用接口/i.test(item.label)) score += 10;
  if (
    plan.concern === 'data_flow'
    && (/链路接口|动作接口|apiCall|补充接口证据|通用接口/i.test(item.label) || hasApiSignal(item.code))
  ) {
    score += 12;
  }
  if (plan.concern === 'pagination' && /page|pagination|pageNum|pageSize/i.test(`${item.label} ${item.code}`)) score += 4;
  if (/页面锚点/.test(item.label)) score += 10;

  return score;
}


export function evidenceCoversNeed(evidence: Evidence[], need: EvidenceNeed): boolean {
  const text = evidence.map((item) => `${item.label} ${item.code}`).join('\n');
  if (need === 'api') return evidence.some((item) => /apiCall|动作接口|补充接口证据|通用接口/i.test(item.label) || hasApiSignal(item.code));
  if (need === 'condition') return /(条件|v-if|v-show|visible|disabled|if\s*\(|\?.*:|&&|\|\|)/i.test(text);
  if (need === 'function') return /(function|handle[A-Z]|open[A-Z]|confirm[A-Z]|submit[A-Z]|\w+\s*\()/i.test(text);
  if (need === 'state') return /(state|data\(|computed|watch|this\.\w+\s*=|ref\(|reactive\()/i.test(text);
  if (need === 'route') return /(route|router|path|页面锚点)/i.test(text);
  if (need === 'pagination') return /(pageNum|pageSize|pagination|currentPage|分页|页码)/i.test(text);
  if (need === 'component') return /(组件|component|<.*>|props|emit|v-model)/i.test(text);
  return false;
}


export function selectFallbackEvidenceByNeed(
  question: string,
  plan: QuestionPlan,
  need: EvidenceNeed,
  scopeFiles: string[],
  maxCount: number = 3
): Evidence[] {
  const facts = recallFacts(question, plan, scopeFiles, 120);
  const scopeSet = new Set(scopeFiles);
  const scopeDirs = Array.from(new Set(scopeFiles.map((file) => path.dirname(file))));
  const scopedFacts = facts.filter((fact) => {
    if (scopeSet.size === 0) return true;
    if (scopeSet.has(fact.filePath)) return true;
    return scopeDirs.some((dir) => fact.filePath.startsWith(dir));
  });
  const matcher: Record<EvidenceNeed, (fact: CodeFact) => boolean> = {
    api: (fact) => fact.kind === 'api',
    condition: (fact) => fact.kind === 'condition',
    function: (fact) => fact.kind === 'logic' || fact.kind === 'trigger',
    state: (fact) => fact.kind === 'state',
    route: (fact) => /route|router|path|meta/.test(fact.text.toLowerCase()),
    pagination: (fact) => /pageNum|pageSize|pagination|currentPage|分页|页码/i.test(fact.text),
    component: (fact) => /component|props|emit|v-model|<.*>/.test(fact.text),
  };
  const predicate = matcher[need];
  if (!predicate) return [];

  const labelByNeed: Record<EvidenceNeed, string> = {
    api: '补充接口证据',
    condition: '补充条件证据',
    function: '补充函数证据',
    state: '补充状态证据',
    route: '补充路由证据',
    pagination: '补充分页证据',
    component: '补充组件证据',
  };
  const matched = scopedFacts
    .filter((fact) => predicate(fact))
    .slice(0, maxCount)
    .map((fact) => ({
      file: fact.filePath,
      line: fact.line,
      code: fact.context ? `${fact.context} => ${fact.text}` : fact.text,
      label: labelByNeed[need],
    }));

  if (matched.length > 0) return matched;

  // 对 api 做强兜底：即使问题词未命中，也从作用域内补接口事实，避免链路回答"无接口证据"。
  if (need === 'api' && factIndex?.facts?.length) {
    const questionTerms = extractQuestionCoreTerms(question);
    const questionLower = question.toLowerCase();
    const factBased = factIndex.facts
      .filter((fact) => {
        if (fact.kind !== 'api') return false;
        if (scopeSet.size === 0) return true;
        if (scopeSet.has(fact.filePath)) return true;
        return scopeDirs.some((dir) => fact.filePath.startsWith(dir));
      })
      .map((fact) => {
        const haystack = `${fact.filePath} ${fact.context ?? ''} ${fact.text}`.toLowerCase();
        let score = 0;
        if (scopeSet.has(fact.filePath)) score += 6;
        else if (scopeDirs.some((dir) => fact.filePath.startsWith(dir))) score += 3;
        for (const term of questionTerms) {
          if (term.length >= 2 && haystack.includes(term)) score += 2;
        }
        if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 6;
        if (/(作废|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|作废)/i.test(haystack)) score += 6;
        return { fact, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.fact)
      .slice(0, maxCount)
      .map((fact) => ({
        file: fact.filePath,
        line: fact.line,
        code: fact.context ? `${fact.context} => ${fact.text}` : fact.text,
        label: labelByNeed[need],
      }));
    if (factBased.length > 0) return factBased;

    // 最终兜底：直接在作用域目录扫描 request 调用，避免链路问题漏接口证据。
    if (currentRepoPath && scopeDirs.length > 0) {
      const endpointRegex = /request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/i;
      const fallback: Array<Evidence & { score: number }> = [];
      const questionTerms = extractQuestionCoreTerms(question);
      const questionLower = question.toLowerCase();
      for (const dir of scopeDirs) {
        const absDir = path.join(currentRepoPath, dir);
        if (!fs.existsSync(absDir)) continue;
        const files = listFilesRecursively(absDir, 4).filter((file) => /\.(ts|js|vue|tsx|jsx)$/i.test(file));
        for (const absFile of files) {
          const filePath = toRepoRelative(absFile);
          let lines: string[] = [];
          try {
            lines = fs.readFileSync(absFile, 'utf-8').split(/\r?\n/);
          } catch {
            continue;
          }
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const m = line.match(endpointRegex);
            if (!m) continue;
            const endpointText = `${m[1].toUpperCase()} ${m[2]}`;
            const haystack = `${filePath} ${endpointText}`.toLowerCase();
            let score = 0;
            for (const term of questionTerms) {
              if (term.length >= 2 && haystack.includes(term)) score += 2;
            }
            if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 6;
            if (/(作废|void|discard|abolish)/i.test(questionLower) && /(void|discard|abolish|作废)/i.test(haystack)) score += 6;
            fallback.push({
              file: filePath,
              line: i + 1,
              code: endpointText,
              label: labelByNeed[need],
              score,
            });
          }
        }
      }
      if (fallback.length > 0) {
        return fallback
          .sort((a, b) => b.score - a.score)
          .slice(0, maxCount)
          .map(({ score, ...item }) => item);
      }
    }
  }
  return [];
}


export function buildPlanEvidence(
  question: string,
  nodes: GraphNode[],
  plan: QuestionPlan,
  anchor: PageAnchor | null,
  componentFiles: string[] = []
): Evidence[] {
  const base = buildEvidence(nodes, 8);
  const scoped: Evidence[] = [];
  let generic = buildGenericEvidence(question, nodes, componentFiles, plan.concern, plan.concern !== 'general', 6);
  if (anchor && plan.concern !== 'general') {
    const scopeDir = path.dirname(anchor.componentFile);
    const scopedGeneric = generic.filter((item) => item.file.startsWith(scopeDir));
    if (scopedGeneric.length >= 3) {
      generic = scopedGeneric;
    }
  }

  if (plan.concern === 'ui_condition') {
    let uiEvidence = buildUiConditionEvidence(question, nodes, componentFiles, 10);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedUi = uiEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedUi.length >= 3) {
        uiEvidence = scopedUi;
      }
    }
    scoped.push(...uiEvidence);
  }
  if (plan.concern === 'pagination') {
    scoped.push(...buildPaginationEvidence(nodes, 8));
  }
  if (plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation' || isFlowQuestion(question)) {
    let graphPathEvidence = buildGraphPathEvidence(question, nodes, plan, anchor, componentFiles, 8);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedPath = graphPathEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedPath.length > 0) {
        graphPathEvidence = scopedPath;
      }
    }
    scoped.push(...graphPathEvidence);
  }
  if (anchor && (plan.concern === 'data_flow' || isFlowQuestion(question))) {
    const scopeDir = path.dirname(anchor.componentFile);
    let flowApiNodes = nodes.filter((node) => node.type === 'apiCall' && node.filePath.startsWith(scopeDir));
    if (flowApiNodes.length < 2) {
      const apiRecallNodes = findRelevantNodes(
        `${anchor.title} ${anchor.componentFile} api request post get verify batch`,
        60,
        {
          ...plan,
          scope: anchor.title,
          keywords: [...plan.keywords, 'api', 'request', 'post', 'get', 'verify', 'batch'],
        }
      );
      flowApiNodes = Array.from(
        new Map(
          [...flowApiNodes, ...apiRecallNodes.filter((node) => node.type === 'apiCall' && node.filePath.startsWith(scopeDir))]
            .map((node) => [node.id, node])
        ).values()
      );
    }

    scoped.push(...flowApiNodes.slice(0, 6).map((node) => ({
      file: node.filePath,
      line: parseLine(node.loc),
      code: node.meta?.apiEndpoint ? `${node.meta.apiMethod ?? 'API'} ${node.meta.apiEndpoint}` : `${node.name}`,
      label: '链路接口',
    })));
  }
  if (plan.concern === 'data_flow' || isFlowQuestion(question)) {
    const flowScopeFiles = Array.from(new Set([
      ...(anchor?.componentFile ? [anchor.componentFile] : []),
      ...componentFiles,
      ...nodes.slice(0, 20).map((node) => node.filePath),
    ]));
    let flowEvidence = buildFlowChainEvidence(question, flowScopeFiles, 10);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedFlow = flowEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedFlow.length > 0) {
        flowEvidence = scopedFlow;
      }
    }
    scoped.push(...flowEvidence);
  }
  if (plan.concern !== 'general') {
    const actionScopeFiles = Array.from(new Set([
      ...(anchor?.componentFile ? [anchor.componentFile] : []),
      ...componentFiles,
      ...nodes.slice(0, 16).map((node) => node.filePath),
    ]));
    let actionEvidence = buildActionBlockEvidence(question, plan, actionScopeFiles, 8);
    if (anchor) {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedAction = actionEvidence.filter((item) => item.file.startsWith(scopeDir));
      if (scopedAction.length > 0) {
        actionEvidence = scopedAction;
      }
    }
    scoped.push(...actionEvidence);
  }
  if (plan.concern === 'api_list' && anchor) {
    const hits = collectPageEndpointHits(anchor).slice(0, 16);
    scoped.push(...hits.map((hit) => ({
      file: hit.file,
      line: hit.line,
      code: `${hit.method} ${hit.endpoint}`,
      label: `apiCall: ${hit.method} ${hit.endpoint}`,
    })));
  }
  // 通用证据只做补位，不抢占专用证据主位
  if (scoped.length < 8) {
    scoped.push(...generic);
  }
  const shouldUseComponentEvidence = componentFiles.length > 0
    && (
      plan.concern === 'component_relation'
      || plan.concern === 'data_flow'
      || plan.concern === 'ui_condition'
      || isComponentFeatureQuestion(question)
      || isFlowQuestion(question)
    );

  const focusComponentFiles = pickHintedComponentFiles(question, componentFiles);
  if (shouldUseComponentEvidence) {
    scoped.push(...buildComponentEvidence(question, nodes, componentFiles, focusComponentFiles, 10));
  }

  if (anchor?.componentFile) {
    const anchorFile = nodes.find((node) => node.filePath === anchor.componentFile);
    if (anchorFile) {
      scoped.unshift({
        file: anchorFile.filePath,
        line: parseLine(anchorFile.loc),
        code: `${anchor.title} (${anchor.routeName ?? 'route'})`,
        label: '页面锚点',
      });
    }
  }

  const merged = Array.from(
    new Map([...scoped, ...base].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  );

  // 若证据仍然不足，增加与问题关键词命中的行级证据
  if (merged.length < 6 && currentRepoPath) {
    const terms = extractSearchTerms(question, plan.keywords).slice(0, 8);
    let candidateFiles = Array.from(new Set([...componentFiles, ...nodes.slice(0, 20).map((node) => node.filePath)]));
    if (anchor && plan.concern !== 'general') {
      const scopeDir = path.dirname(anchor.componentFile);
      const scopedFiles = candidateFiles.filter((file) => file.startsWith(scopeDir));
      if (scopedFiles.length > 0) {
        candidateFiles = scopedFiles;
      }
    }
    for (const file of candidateFiles) {
      const absPath = path.join(currentRepoPath, file);
      if (!fs.existsSync(absPath)) continue;
      try {
        const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i].trim();
          if (!text) continue;
          const lower = text.toLowerCase();
          if (!terms.some((term) => lower.includes(term))) continue;
          merged.push({
            file,
            line: i + 1,
            code: text,
            label: '上下文线索',
          });
          if (merged.length >= 12) break;
        }
      } catch {
        // ignore
      }
      if (merged.length >= 12) break;
    }
  }

  const deduped = Array.from(new Map(merged.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values());
  const enriched = isUiConditionQuestion(question)
    ? enrichEvidenceWithButtonConditions(question, deduped, 24)
    : deduped;
  const scopedFilesForNeed = Array.from(new Set([
    ...(anchor?.componentFile ? [anchor.componentFile] : []),
    ...componentFiles,
    ...nodes.slice(0, 20).map((node) => node.filePath),
  ]));
  const strictScopeFilesForNeed = (() => {
    if (!anchor || plan.concern === 'general') return scopedFilesForNeed;
    const scopeDir = path.dirname(anchor.componentFile);
    const scoped = scopedFilesForNeed.filter((file) => file.startsWith(scopeDir));
    if (scoped.length > 0) return scoped;
    return [
      anchor.componentFile,
      ...componentFiles.filter((file) => file.startsWith(scopeDir)),
    ];
  })();
  const withNeedCoverage = [...enriched];
  for (const need of plan.mustEvidence) {
    const forceApiForFlow = need === 'api' && plan.concern === 'data_flow';
    if (!forceApiForFlow && evidenceCoversNeed(withNeedCoverage, need)) continue;
    const supplements = selectFallbackEvidenceByNeed(question, plan, need, strictScopeFilesForNeed, 2);
    if (need === 'api') {
      withNeedCoverage.unshift(...supplements);
    } else {
      withNeedCoverage.push(...supplements);
    }
  }
  if (
    (plan.concern === 'data_flow' || plan.concern === 'api_list' || plan.concern === 'component_relation')
    && !evidenceCoversNeed(withNeedCoverage, 'api')
  ) {
    withNeedCoverage.unshift(...selectFallbackEvidenceByNeed(question, plan, 'api', strictScopeFilesForNeed, 3));
  }

  const ranked = Array.from(new Map(withNeedCoverage.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .map((item) => ({
      item,
      score: scoreEvidenceItem(item, question, plan, anchor, componentFiles),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  let ordered = ranked;
  if (anchor && plan.concern !== 'general') {
    const scopeDir = path.dirname(anchor.componentFile);
    const inScope = ranked.filter((item) => item.file.startsWith(scopeDir));
    if (inScope.length >= 6) {
      ordered = inScope;
    } else {
      ordered = [...inScope, ...ranked.filter((item) => !item.file.startsWith(scopeDir))];
    }
  }

  let finalEvidence = ordered.slice(0, 12);
  const forcedNeeds: EvidenceNeed[] = (plan.concern === 'data_flow' || isFlowQuestion(question))
    ? ['api', 'function', 'condition']
    : [];
  const mustCheckNeeds = Array.from(new Set<EvidenceNeed>([
    ...plan.mustEvidence,
    ...forcedNeeds,
  ]));
  for (const need of mustCheckNeeds) {
    if (evidenceCoversNeed(finalEvidence, need)) continue;
    const supplements = selectFallbackEvidenceByNeed(question, plan, need, strictScopeFilesForNeed, need === 'api' ? 3 : 2);
    if (supplements.length === 0) continue;
    finalEvidence = Array.from(
      new Map([...supplements, ...finalEvidence].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
    ).slice(0, 12);
  }

  return finalEvidence;
}
