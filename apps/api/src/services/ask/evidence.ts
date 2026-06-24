// ============================================================
// 证据构建器
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
  type FactKind,
  type CodeFact,
  type PlanConcern,
  type QuestionPlan,
  type ImportedSymbolBinding,
  type ApiFunctionEndpointEvidence,
  type GenericEvidenceKind,
} from '../../context.js';
import { parseLine, escapeRegex, tokenizeForRecall } from './textUtils.js';
import { hasApiSignal, extractMethodNamesFromEventLine, findMethodDefinitionLine, resolveMethodScanEnd, isMethodRelevantToQuestion } from './codeScan.js';
import { extractQuestionCoreTerms, extractButtonLabelKeywords, extractSearchTerms } from './questionAnalysis.js';
import { recallFacts } from './recall.js';
import { extractImportBindingsFromFile, buildApiFunctionEndpointMap } from './componentScope.js';


export function buildEvidence(nodes: GraphNode[], maxEvidence: number = 8): Evidence[] {
  const primary = nodes.filter((node) => node.type !== 'file' && node.type !== 'import');
  const source = (primary.length > 0 ? primary : nodes).slice(0, maxEvidence);
  return source.map((node) => ({
    file: node.filePath,
    line: parseLine(node.loc),
    code: `${node.type} ${node.name}`,
    label: `${node.type}: ${node.name}`,
  }));
}


function scoreGenericEvidenceLine(line: string, coreTerms: string[]): { score: number; kind: GenericEvidenceKind | null; termHits: number } {
  const text = line.trim();
  if (!text) return { score: 0, kind: null, termHits: 0 };
  const lower = text.toLowerCase();

  let score = 0;
  const kindScore: Record<GenericEvidenceKind, number> = { condition: 0, trigger: 0, state: 0, api: 0, logic: 0 };

  if (/(v-if|v-show|visible\s*:|disabled\s*:|disabled\s*=|if\s*\(|\?.*:|&&|\|\||\breturn\b)/i.test(text)) { kindScore.condition += 4; score += 4; }
  if (/(onClick=|@click=|handleClick|handle\w+\(|open\w+\(|confirm\w+\(|submit\w+\()/i.test(text)) { kindScore.trigger += 4; score += 4; }
  if (/(this\.\w+\s*=|reactive\(|ref\(|computed\(|watch\(|use\w+\(|set\w+\()/i.test(text)) { kindScore.state += 3; score += 3; }
  if (hasApiSignal(text)) { kindScore.api += 4; score += 4; }
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(|^\s*const\s+[A-Za-z_$][\w$]*\s*=/.test(text)) { kindScore.logic += 2; score += 2; }

  let termHits = 0;
  for (const term of coreTerms) {
    if (lower.includes(term)) { score += 2; termHits++; }
  }
  if (termHits === 0 && coreTerms.length > 0) score -= 1;

  const orderedKinds = Object.entries(kindScore).sort((a, b) => b[1] - a[1]) as Array<[GenericEvidenceKind, number]>;
  const topKind = orderedKinds[0];
  if (!topKind || topKind[1] <= 0) return { score: Math.max(score, 0), kind: null, termHits };
  return { score, kind: topKind[0], termHits };
}


export function buildGenericEvidence(question: string, nodes: GraphNode[], scopeFiles: string[] = [], concern: PlanConcern = 'general', requireTermHit: boolean = false, maxEvidence: number = 8): Evidence[] {
  if (!currentRepoPath) return [];
  const coreTerms = extractQuestionCoreTerms(question);
  const candidateFiles = Array.from(new Set([...scopeFiles, ...nodes.slice(0, 28).map((node) => node.filePath)])).filter((file) => /\.(vue|tsx?|jsx?|ts|js)$/i.test(file));
  const candidateFileSet = new Set(candidateFiles);

  const kindLabelMap: Record<FactKind, string> = { condition: '通用条件', trigger: '通用触发', state: '通用状态', api: '通用接口', logic: '通用逻辑' };
  const concernBoost: Partial<Record<PlanConcern, Partial<Record<FactKind, number>>>> = {
    ui_condition: { condition: 3, trigger: 2 }, data_flow: { trigger: 3, state: 2, api: 2 }, state_flow: { state: 3, condition: 2 },
    api_list: { api: 4, trigger: 1 }, pagination: { condition: 1, state: 2, api: 1 }, component_relation: { trigger: 2, condition: 2, state: 1 },
  };

  const hits: Array<Evidence & { score: number }> = [];

  if (factIndex?.facts?.length) {
    const fileFilteredFacts = factIndex.facts.filter((fact) => candidateFileSet.size === 0 || candidateFileSet.has(fact.filePath));
    for (const fact of fileFilteredFacts) {
      let termHits = 0;
      for (const term of coreTerms) { if (fact.terms.includes(term) || fact.text.toLowerCase().includes(term)) termHits++; }
      if (requireTermHit && coreTerms.length > 0 && termHits === 0) continue;
      let score = termHits * 3;
      score += concernBoost[concern]?.[fact.kind] ?? 0;
      if (scopeFiles.includes(fact.filePath)) score += 2;
      if (fact.context && coreTerms.some((term) => fact.context!.toLowerCase().includes(term))) score += 2;
      if (coreTerms.length === 0) score += 1;
      if (score < 3) continue;
      hits.push({ file: fact.filePath, line: fact.line, code: fact.context ? `${fact.context} => ${fact.text}` : fact.text, label: kindLabelMap[fact.kind], score });
    }
    return Array.from(new Map(hits.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
      .sort((a, b) => b.score - a.score).slice(0, maxEvidence).map(({ score, ...item }) => item);
  }

  for (const file of candidateFiles) {
    const absPath = path.join(currentRepoPath, file);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try { lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/); } catch { continue; }
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      const { score, kind, termHits } = scoreGenericEvidenceLine(text, coreTerms);
      if (!kind || score < 5) continue;
      if (requireTermHit && coreTerms.length > 0 && termHits <= 0) continue;
      hits.push({ file, line: i + 1, code: text, label: kindLabelMap[kind], score });
    }
  }

  return Array.from(new Map(hits.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score).slice(0, maxEvidence).map(({ score, ...item }) => item);
}


export function collectConditionMethodEvidence(
  filePath: string,
  methodNames: string[],
  questionTerms: string[],
  maxEvidence: number
): Array<Evidence & { score: number }> {
  if (!currentRepoPath || maxEvidence <= 0) return [];
  const absPath = path.join(currentRepoPath, filePath);
  if (!fs.existsSync(absPath)) return [];

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }

  const safeNames = Array.from(new Set(methodNames))
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
    .slice(0, 20);
  if (safeNames.length === 0) return [];

  const results: Array<Evidence & { score: number }> = [];
  for (const methodName of safeNames) {
    const defRegex = new RegExp(`^\\s*(?:async\\s+)?${escapeRegex(methodName)}\\s*\\(`);
    const startLine = lines.findIndex((line) => defRegex.test(line));
    if (startLine < 0) continue;

    results.push({
      file: filePath,
      line: startLine + 1,
      code: lines[startLine].trim(),
      label: '条件函数',
      score: 12,
    });

    for (let i = startLine; i < Math.min(lines.length, startLine + 28); i++) {
      const text = lines[i].trim();
      if (!text) continue;
      if (!/(return|if\s*\(|\?|&&|\|\||===|!==|>=|<=|status|visible|disabled|permission|audit|void|discard|check|verify|stock|receive)/i.test(text)) {
        continue;
      }
      const lower = text.toLowerCase();
      let score = 6;
      if (/\breturn\b|if\s*\(/i.test(text)) score += 3;
      if (/(===|!==|>=|<=|&&|\|\|)/.test(text)) score += 2;
      let strictHit = 0;
      for (const term of questionTerms) {
        if (term.length >= 2 && lower.includes(term)) {
          score += 2;
          strictHit++;
        }
      }
      if (strictHit === 0 && questionTerms.length > 0) score -= 1;
      results.push({
        file: filePath,
        line: i + 1,
        code: text,
        label: '条件判断',
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence);
}


export function buildActionBlockEvidence(
  question: string,
  plan: QuestionPlan,
  scopeFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  const recalled = recallFacts(question, plan, scopeFiles, 260).filter((fact) => fact.context?.startsWith('action:'));
  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const scopeSet = new Set(scopeFiles);

  const groupMap = new Map<string, { score: number; facts: Array<CodeFact & { score: number }> }>();
  for (const fact of recalled) {
    const key = `${fact.filePath}|${fact.context ?? ''}`;
    const prev = groupMap.get(key) ?? { score: 0, facts: [] };
    let gScore = fact.score;
    if (buttonTerms.length > 0 && buttonTerms.some((term) => (fact.context ?? '').toLowerCase().includes(term))) gScore += 6;
    if (scopeSet.has(fact.filePath)) gScore += 2;
    prev.score += gScore;
    prev.facts.push(fact);
    groupMap.set(key, prev);
  }

  const kindLabel: Record<FactKind, string> = {
    condition: '动作条件',
    trigger: '动作触发',
    state: '动作状态',
    api: '动作接口',
    logic: '动作逻辑',
  };
  const kindPriorityByConcern: Record<PlanConcern, FactKind[]> = {
    ui_condition: ['condition', 'trigger', 'state', 'api', 'logic'],
    data_flow: ['trigger', 'condition', 'state', 'api', 'logic'],
    state_flow: ['state', 'condition', 'trigger', 'api', 'logic'],
    api_list: ['api', 'trigger', 'condition', 'state', 'logic'],
    pagination: ['condition', 'state', 'trigger', 'api', 'logic'],
    component_relation: ['trigger', 'condition', 'state', 'api', 'logic'],
    error_trace: ['logic', 'condition', 'state', 'trigger', 'api'],
    general: ['condition', 'trigger', 'state', 'api', 'logic'],
  };
  const kindPriority = kindPriorityByConcern[plan.concern] ?? kindPriorityByConcern.general;

  const selectedGroups = Array.from(groupMap.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5);

  const evidence: Evidence[] = [];
  for (const [, group] of selectedGroups) {
    const usedKinds = new Set<FactKind>();
    for (const kind of kindPriority) {
      const matched = group.facts
        .filter((fact) => fact.kind === kind)
        .sort((a, b) => b.score - a.score)[0];
      if (!matched || usedKinds.has(kind)) continue;
      usedKinds.add(kind);
      evidence.push({
        file: matched.filePath,
        line: matched.line,
        code: matched.context ? `${matched.context} => ${matched.text}` : matched.text,
        label: kindLabel[kind],
      });
      if (evidence.length >= maxEvidence) return evidence;
    }
  }

  return evidence;
}


export function buildFlowChainEvidence(
  question: string,
  scopeFiles: string[] = [],
  maxEvidence: number = 10
): Evidence[] {
  if (!currentRepoPath || scopeFiles.length === 0 || maxEvidence <= 0) return [];

  const questionTerms = extractQuestionCoreTerms(question);
  const questionLower = question.toLowerCase();
  const buttonTerms = extractButtonLabelKeywords(question).map((term) => term.toLowerCase());
  const candidateFiles = Array.from(new Set(scopeFiles)).filter((file) => /\.(vue|tsx?|jsx?|ts|js)$/i.test(file));
  const importBindingsByFile = new Map<string, ImportedSymbolBinding[]>();
  const apiFunctionEndpointCache = new Map<string, Map<string, ApiFunctionEndpointEvidence[]>>();

  const methodHintsByFile = new Map<string, Set<string>>();
  const secondHopMethods = new Set<string>();
  const secondHopRefHints = new Map<string, Set<string>>();
  const rows: Array<Evidence & { score: number }> = [];

  const pushRow = (item: Evidence & { score: number }): void => {
    if (item.score < 4) return;
    rows.push(item);
  };

  for (const filePath of candidateFiles) {
    if (!importBindingsByFile.has(filePath)) {
      const bindings = extractImportBindingsFromFile(filePath).filter((binding) =>
        /(\/api\/|request\.(ts|js)$|api\/index\.(ts|js)$)/i.test(binding.sourceFile)
      );
      importBindingsByFile.set(filePath, bindings);
      for (const binding of bindings) {
        if (apiFunctionEndpointCache.has(binding.sourceFile)) continue;
        apiFunctionEndpointCache.set(binding.sourceFile, buildApiFunctionEndpointMap(binding.sourceFile));
      }
    }

    const absPath = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    const methodHints = methodHintsByFile.get(filePath) ?? new Set<string>();
    const buttonAnchorLines = new Set<number>();
    if (buttonTerms.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const hasButtonTerm = buttonTerms.some((term) => lower.includes(term));
        if (!hasButtonTerm) continue;
        if (!/(name\s*:|alias\s*:|<el-button|按钮|action)/i.test(text)) continue;
        buttonAnchorLines.add(i);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      const lower = text.toLowerCase();
      const clickSignal = /(handleClick\s*:|onClick=|@click=)/i.test(text);
      if (clickSignal) {
        const extractedMethods = extractMethodNamesFromEventLine(text);
        const hasButtonTerm = buttonTerms.length > 0 && buttonTerms.some((term) => lower.includes(term));
        const nearButtonAnchor = buttonAnchorLines.size > 0
          && Array.from(buttonAnchorLines).some((anchorLine) => Math.abs(anchorLine - i) <= 6);
        const hasRelevantMethod = extractedMethods.some((method) => isMethodRelevantToQuestion(method, questionLower));
        if (buttonTerms.length > 0 && !hasButtonTerm && (!nearButtonAnchor || !hasRelevantMethod)) {
          continue;
        }
        let score = 8;
        if (hasButtonTerm) score += 8;
        if (nearButtonAnchor) score += 4;
        for (const term of questionTerms) {
          if (term.length >= 2 && lower.includes(term)) score += 2;
        }
        pushRow({
          file: filePath,
          line: i + 1,
          code: text,
          label: '链路触发',
          score,
        });
        for (const method of extractedMethods) {
          if (!hasButtonTerm && buttonTerms.length > 0 && !isMethodRelevantToQuestion(method, questionLower)) continue;
          methodHints.add(method);
        }
      }
    }
    if (methodHints.size > 0) {
      methodHintsByFile.set(filePath, methodHints);
    }

    for (const methodName of Array.from(methodHints).slice(0, 16)) {
      if (buttonTerms.length > 0 && !isMethodRelevantToQuestion(methodName, questionLower)) continue;
      const defLine = findMethodDefinitionLine(lines, methodName);
      if (defLine < 0) continue;
      pushRow({
        file: filePath,
        line: defLine + 1,
        code: lines[defLine].trim(),
        label: '链路函数',
        score: 12,
      });

      const endLine = resolveMethodScanEnd(lines, defLine, 36);
      for (let j = defLine; j <= endLine; j++) {
        const code = lines[j].trim();
        if (!code) continue;
        const lower = code.toLowerCase();
        if (hasApiSignal(code)) {
          let score = 14;
          for (const term of questionTerms) {
            if (term.length >= 2 && lower.includes(term)) score += 2;
          }
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路接口',
            score,
          });
        } else if (/(this\.\$refs\.\w+\.\w+\(|\.(open|confirm|submit|verify|check)\w*\(|\b(open|confirm|submit|verify|check)\w*\()/i.test(code)) {
          let score = 9;
          for (const term of questionTerms) {
            if (term.length >= 2 && lower.includes(term)) score += 1;
          }
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路调用',
            score,
          });
          const callMatches = Array.from(code.matchAll(/\.(\w+)\s*\(/g));
          for (const match of callMatches) {
            const called = (match[1] ?? '').trim();
            if (!/^[A-Za-z_$][\w$]*$/.test(called)) continue;
            if (!/^(open|confirm|submit|verify|check|batch)/i.test(called)) continue;
            if (called === methodName) continue;
            secondHopMethods.add(called);
          }
          const refMatches = Array.from(code.matchAll(/this\.\$refs\.(\w+)\.(\w+)\s*\(/g));
          for (const match of refMatches) {
            const refName = (match[1] ?? '').trim();
            const called = (match[2] ?? '').trim();
            if (!refName || !called) continue;
            secondHopMethods.add(called);
            const refs = secondHopRefHints.get(called) ?? new Set<string>();
            refs.add(refName.toLowerCase());
            secondHopRefHints.set(called, refs);
          }
        }

        // 补充：导入的 API 包装函数映射到真实 endpoint（例如 verify -> POST /xxx/verify）
        const importBindings = importBindingsByFile.get(filePath) ?? [];
        for (const binding of importBindings) {
          const bindingPattern = new RegExp(`\\b${escapeRegex(binding.localName)}\\b`);
          if (!bindingPattern.test(code)) continue;
          const endpointMap = apiFunctionEndpointCache.get(binding.sourceFile);
          if (!endpointMap) continue;
          const endpointItems = endpointMap.get(binding.importedName) ?? endpointMap.get(binding.localName) ?? [];
          for (const item of endpointItems.slice(0, 2)) {
            let score = 12;
            const haystack = `${item.functionName} ${item.method} ${item.endpoint}`.toLowerCase();
            for (const term of questionTerms) {
              if (term.length >= 2 && haystack.includes(term)) score += 2;
            }
            if (/(核实|verify|check|确认)/i.test(questionLower) && /(verify|check|confirm|核实)/i.test(haystack)) score += 4;
            pushRow({
              file: item.filePath,
              line: item.line,
              code: `${item.method} ${item.endpoint} (via ${binding.localName})`,
              label: '链路接口',
              score,
            });
          }
        }
      }
    }
  }

  if (secondHopMethods.size > 0) {
    const methodList = Array.from(secondHopMethods).slice(0, 20);
    for (const filePath of candidateFiles) {
      const absPath = path.join(currentRepoPath, filePath);
      if (!fs.existsSync(absPath)) continue;
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      } catch {
        continue;
      }

      for (const methodName of methodList) {
        const defLine = findMethodDefinitionLine(lines, methodName);
        if (defLine < 0) continue;
        const refHints = secondHopRefHints.get(methodName);
        if (refHints && refHints.size > 0) {
          const fileKey = filePath.toLowerCase().replace(/[^a-z0-9]/g, '');
          const isHintedFile = Array.from(refHints).some((ref) => {
            const refKey = ref.toLowerCase().replace(/[^a-z0-9]/g, '');
            return refKey.length >= 3 && fileKey.includes(refKey);
          });
          if (!isHintedFile) continue;
        }
        pushRow({
          file: filePath,
          line: defLine + 1,
          code: lines[defLine].trim(),
          label: '链路函数',
          score: 10,
        });
        const endLine = resolveMethodScanEnd(lines, defLine, 34);
        for (let j = defLine; j <= endLine; j++) {
          const code = lines[j].trim();
          if (!code) continue;
          if (!hasApiSignal(code)) continue;
          pushRow({
            file: filePath,
            line: j + 1,
            code,
            label: '链路接口',
            score: 12,
          });
        }
      }
    }
  }

  return Array.from(new Map(rows.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}


export function buildUiConditionEvidence(
  question: string,
  nodes: GraphNode[],
  scopeFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!currentRepoPath) return [];

  const candidateFiles = new Set<string>(scopeFiles);
  for (const node of nodes.slice(0, 24)) {
    if (/\.(vue|jsx?|tsx?)$/i.test(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
    if (node.filePath.includes('/api/')) {
      candidateFiles.add(node.filePath.replace('/api/', '/').replace(/request\.(js|ts)$/, 'index.vue'));
    }
  }

  const result: Array<Evidence & { score: number }> = [];
  const questionTerms = extractSearchTerms(question).slice(0, 10);
  const strictTerms = tokenizeForRecall(question).filter((term) => term.length >= 2).slice(0, 12);
  const buttonLabels = extractButtonLabelKeywords(question);
  const uiSignalPattern = /(v-if|v-show|visible\s*:|disabled\s*=|disabled\s*:|show\s*:|hide\s*:|v-permission|permission|onClick=|@click=|handleClick\s*:|&&\s*<|\?[^:]*<el-button|<el-button|alias\s*:)/i;
  const methodNameHintPattern = /^(is|has|can|show|hide|should|check|allow|enable|disabled|visible|pending|void|audit|verify)/i;
  for (const filePath of candidateFiles) {
    if (!/\.(vue|jsx?|tsx?)$/i.test(filePath)) continue;
    const absPath = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      const methodRefs = new Set<string>();
      const lineHits: Array<Evidence & { score: number }> = [];
      const buttonAnchorLines = new Set<number>();
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const hasButtonLabel = buttonLabels.some((label) => text.includes(label));
        if (!uiSignalPattern.test(text) && !hasButtonLabel) continue;
        const lower = text.toLowerCase();
        let score = 1;
        if (/(<el-button|按钮|button|alias\s*:)/i.test(text)) score += 3;
        if (/\bname\s*:/.test(text)) score += 2;
        if (/(v-if|v-show|visible\s*:|disabled|permission|&&\s*<|\?)/i.test(text)) score += 4;
        if (/(handleClick|onClick|@click|openDialog|confirm|batch|void|discard|abolish|verify|check)/i.test(text)) score += 4;
        if (hasButtonLabel) score += 10;
        let strictHit = 0;
        for (const term of strictTerms) {
          if (lower.includes(term)) {
            score += 3;
            strictHit++;
          }
        }
        for (const term of questionTerms) {
          if (lower.includes(term)) score += 1;
        }
        if (strictHit === 0 && strictTerms.length > 0) score -= 2;
        if (/^src\/components\//.test(filePath) && strictHit === 0) score -= 2;

        const questionLower = question.toLowerCase();
        if (questionLower.includes('作废') && /(作废|void|discard|abolish)/i.test(text)) score += 8;
        if ((questionLower.includes('核实') || questionLower.includes('校验')) && /(核实|verify|check|confirmData)/i.test(text)) score += 8;
        if (questionLower.includes('作废') && !/(作废|void|discard|abolish)/i.test(text)) score -= 4;
        if ((questionLower.includes('核实') || questionLower.includes('校验')) && !/(核实|verify|check|confirmData)/i.test(text)) score -= 4;

        if (score < 2) continue;
        const evidenceItem: Evidence & { score: number } = {
          file: filePath,
          line: i + 1,
          code: text,
          label: /(v-if|v-show|visible|disabled|status|permission|\?)/i.test(text) ? 'UI 条件' : 'UI 触发',
          score,
        };
        lineHits.push(evidenceItem);
        if (hasButtonLabel) {
          buttonAnchorLines.add(i);
        }

        // 对"按钮定义行"补抓同一代码块邻近条件行（visible/disabled/handleClick）。
        if (hasButtonLabel) {
          for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 8); j++) {
            if (j === i) continue;
            const neighbor = lines[j].trim();
            if (!neighbor) continue;
            if (!/(visible\s*:|disabled\s*:|disabled\s*=|handleClick\s*:|onClick=|@click=|params\s*:|v-if|v-show)/i.test(neighbor)) continue;
            let neighborScore = score - 2;
            if (/(visible\s*:|disabled)/i.test(neighbor)) neighborScore += 6;
            if (/(handleClick\s*:|onClick=|@click=)/i.test(neighbor)) neighborScore += 4;
            lineHits.push({
              file: filePath,
              line: j + 1,
              code: neighbor,
              label: /(visible\s*:|disabled|v-if|v-show)/i.test(neighbor) ? 'UI 条件' : 'UI 触发',
              score: Math.max(neighborScore, 5),
            });
          }
        }

        const conditionLikeLine = /(visible\s*:|disabled\s*=|disabled\s*:|v-if|v-show|&&\s*<|\?[^:]*<)/i.test(text);
        if (conditionLikeLine) {
          const methodRefRegex = /this\.(\w+)\s*\(/g;
          let match: RegExpExecArray | null = null;
          while ((match = methodRefRegex.exec(text)) !== null) {
            const methodName = match[1];
            if (!methodName) continue;
            if (methodNameHintPattern.test(methodName) || /(visible|disabled|status)/i.test(text)) {
              methodRefs.add(methodName);
            }
          }
        }
      }

      // 如果命中了具体按钮名，压低本文件内与按钮无关的证据噪音。
      const fileScopedHits = buttonAnchorLines.size > 0
        ? lineHits.filter((item) => {
            const dist = Math.min(...Array.from(buttonAnchorLines).map((line) => Math.abs((item.line - 1) - line)));
            return dist <= 24 || /(visible|disabled|handleClick|name\s*:|alias\s*:)/i.test(item.code);
          })
        : lineHits;
      result.push(...fileScopedHits);

      if (methodRefs.size > 0) {
        result.push(...collectConditionMethodEvidence(filePath, Array.from(methodRefs), strictTerms, Math.max(5, Math.floor(maxEvidence / 2))));
      }
    } catch {
      // ignore
    }
  }

  return Array.from(new Map(result.map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}


export function buildPaginationEvidence(nodes: GraphNode[], maxEvidence: number = 6): Evidence[] {
  if (!currentRepoPath) return [];

  const candidateFiles = new Set<string>(['src/components/YLTable/index.jsx']);
  for (const node of nodes.slice(0, 20)) {
    if (/\.(vue|jsx|tsx?|js)$/.test(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
    if (node.filePath.includes('/api/')) {
      candidateFiles.add(node.filePath.replace('/api/', '/').replace(/request\.(js|ts)$/, 'index.vue'));
    }
  }

  const result: Evidence[] = [];
  const pattern = /(pageNum|pageSize|pagination|fetchTableData|getTableData|queryParams|currentPage|每页|页码)/i;
  for (const filePath of candidateFiles) {
    const absPath = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text || !pattern.test(text)) continue;
        result.push({
          file: filePath,
          line: i + 1,
          code: text,
          label: '分页线索',
        });
        if (result.length >= maxEvidence) return result;
      }
    } catch {
      // ignore
    }
  }

  return result;
}


export function buildComponentEvidence(
  question: string,
  nodes: GraphNode[],
  componentFiles: string[],
  focusFiles: string[] = [],
  maxEvidence: number = 8
): Evidence[] {
  if (!currentRepoPath) return [];

  const questionTerms = extractSearchTerms(question).slice(0, 12);
  const candidateFiles = new Set<string>([...focusFiles, ...componentFiles]);
  const focusFileSet = new Set(focusFiles);
  for (const node of nodes.slice(0, 20)) {
    if (componentFiles.includes(node.filePath)) {
      candidateFiles.add(node.filePath);
    }
  }

  const result: Array<Evidence & { score: number }> = [];
  const signalPattern = /(props|emit|emits|v-model|watch|computed|methods|setup|defineprops|defineemits|open|dialog|drawer|click|handle|submit|confirm|filter|sort|table|pagination|validate|rule|void|abolish|discard|verify|batch|作废|核实|入库|出库|收货)/i;
  for (const filePath of candidateFiles) {
    if (!/\.(vue|tsx?|jsx?|js)$/.test(filePath)) continue;
    const absPath = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(absPath)) continue;
    try {
      const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        let score = 0;

        if (signalPattern.test(text)) score += 3;
        if (/(v-if|v-show|disabled|visible|show|hide|status|permission|if\s*\()/i.test(text)) score += 2;
        if (/(request\.(get|post|put|delete|patch)|axios|fetch)/i.test(text)) score += 2;
        if (/(confirmData|openVoidDialog|handleBatchCommand|batchVerify|verify|ReceivingVoidDialog|afterSubmit)/i.test(text)) score += 4;
        if (/@click\s*=\s*["'{][^"'}]*(confirm|submit|void|verify|check)[^"'}]*/i.test(text)) score += 8;
        if (/(confirmData\(|requestMethod|batchVerify\(|verify\(|openDialog\(|openVoidDialog\()/i.test(text)) score += 8;
        if (focusFileSet.has(filePath)) score += 4;
        for (const term of questionTerms) {
          if (term.length < 2) continue;
          if (lower.includes(term)) score += 1;
        }

        if (score < 3) continue;
        result.push({
          file: filePath,
          line: i + 1,
          code: text,
          label: /(v-if|v-show|visible|disabled|status)/i.test(text) ? '组件条件' : '组件逻辑',
          score,
        });
      }
    } catch {
      // ignore
    }
  }

  return result
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvidence)
    .map(({ score, ...item }) => item);
}


export function enrichEvidenceWithButtonConditions(question: string, evidence: Evidence[], maxEvidence: number = 12): Evidence[] {
  if (!currentRepoPath || evidence.length === 0) return evidence.slice(0, maxEvidence);

  const labels = extractButtonLabelKeywords(question);
  if (labels.length === 0) return evidence.slice(0, maxEvidence);

  const supplements: Evidence[] = [];
  const groupedByFile = new Map<string, Evidence[]>();
  for (const item of evidence) {
    const list = groupedByFile.get(item.file) ?? [];
    list.push(item);
    groupedByFile.set(item.file, list);
  }

  for (const [file, list] of groupedByFile.entries()) {
    const anchors = list.filter((item) =>
      labels.some((label) => item.code.includes(label))
      && /(<el-button|name\s*:|alias\s*:)/i.test(item.code)
    );
    if (anchors.length === 0) continue;

    const absPath = path.join(currentRepoPath, file);
    if (!fs.existsSync(absPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
    } catch {
      continue;
    }

    for (const anchor of anchors) {
      const lineIdx = Math.max(0, anchor.line - 1);
      for (let i = Math.max(0, lineIdx - 4); i <= Math.min(lines.length - 1, lineIdx + 8); i++) {
        if (i === lineIdx) continue;
        const text = (lines[i] ?? '').trim();
        if (!text) continue;
        if (!/(visible\s*:|disabled\s*:|disabled\s*=|v-if|v-show|permission|handleClick\s*:|onClick=|@click=)/i.test(text)) continue;
        supplements.push({
          file,
          line: i + 1,
          code: text,
          label: /(visible\s*:|disabled|v-if|v-show|permission)/i.test(text) ? 'UI 条件' : 'UI 触发',
        });
      }
    }
  }

  return Array.from(
    new Map([...supplements, ...evidence].map((item) => [`${item.file}:${item.line}:${item.label}`, item])).values()
  ).slice(0, maxEvidence);
}
