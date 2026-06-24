// ============================================================
// 组件作用域 & import 解析
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import {
  currentRepoPath,
  type ImportedSymbolBinding,
  type ApiFunctionEndpointEvidence,
} from '../../context.js';
import { tokenizeForRecall } from './textUtils.js';
import { toRepoRelative, resolveMethodScanEnd } from './codeScan.js';
import { extractQuestionComponentHints } from './questionAnalysis.js';


export function pickHintedComponentFiles(question: string, componentFiles: string[]): string[] {
  const hints = extractQuestionComponentHints(question);
  if (hints.length === 0 || componentFiles.length === 0) return [];

  return componentFiles.filter((file) => {
    const fileKey = file.toLowerCase().replace(/[^a-z0-9]/g, '');
    return hints.some((hint) => fileKey.includes(hint) || hint.includes(path.basename(file).toLowerCase().replace(/[^a-z0-9]/g, '')));
  });
}


export function resolveRepoImportPath(fromRepoFile: string, specifier: string): string | null {
  if (!currentRepoPath) return null;
  const spec = specifier.trim();
  if (!spec) return null;
  if (!spec.startsWith('@/') && !spec.startsWith('./') && !spec.startsWith('../')) {
    return null;
  }

  const base = spec.startsWith('@/') ? path.join(currentRepoPath, 'src', spec.slice(2)) : path.join(currentRepoPath, path.dirname(fromRepoFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.vue`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.vue'),
  ];

  for (const absPath of candidates) {
    if (!fs.existsSync(absPath)) continue;
    const rel = toRepoRelative(absPath);
    if (!rel.startsWith('src/')) continue;
    return rel;
  }
  return null;
}


export function extractLocalImportsFromFile(repoFilePath: string): string[] {
  if (!currentRepoPath) return [];
  const absPath = path.join(currentRepoPath, repoFilePath);
  if (!fs.existsSync(absPath)) return [];

  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const imports: string[] = [];
  const importRegex = /import[\s\S]*?from\s*['"`]([^'"`]+)['"`]/g;
  const dynamicRegex = /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = importRegex.exec(content)) !== null) {
    const resolved = resolveRepoImportPath(repoFilePath, match[1]);
    if (resolved) imports.push(resolved);
  }
  while ((match = dynamicRegex.exec(content)) !== null) {
    const resolved = resolveRepoImportPath(repoFilePath, match[1]);
    if (resolved) imports.push(resolved);
  }

  return Array.from(new Set(imports));
}


export function collectComponentScopeFiles(entryFile: string, maxDepth: number = 2, maxFiles: number = 120): string[] {
  const results = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: entryFile, depth: 0 }];

  while (queue.length > 0 && results.size < maxFiles) {
    const current = queue.shift()!;
    if (results.has(current.file)) continue;
    results.add(current.file);

    if (current.depth >= maxDepth) continue;
    const imports = extractLocalImportsFromFile(current.file);
    for (const imported of imports) {
      if (results.has(imported)) continue;
      queue.push({ file: imported, depth: current.depth + 1 });
    }
  }

  return Array.from(results);
}


export function collectComponentScopeTerms(componentFiles: string[]): string[] {
  const terms: string[] = [];
  for (const file of componentFiles) {
    const base = path.basename(file).replace(/\.(vue|tsx?|jsx?)$/i, '');
    const segments = file.split('/');
    terms.push(base);
    terms.push(...segments);
  }
  return Array.from(new Set(terms.flatMap((term) => tokenizeForRecall(term)).filter((term) => term.length >= 2))).slice(0, 40);
}


export function extractImportBindingsFromFile(repoFilePath: string): ImportedSymbolBinding[] {
  if (!currentRepoPath) return [];
  const absPath = path.join(currentRepoPath, repoFilePath);
  if (!fs.existsSync(absPath)) return [];

  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return [];
  }

  const bindings: ImportedSymbolBinding[] = [];
  const importRegex = /import\s+([\s\S]*?)\s+from\s*['"`]([^'"`]+)['"`]/g;
  let match: RegExpExecArray | null = null;
  while ((match = importRegex.exec(content)) !== null) {
    const clause = (match[1] ?? '').trim();
    const specifier = (match[2] ?? '').trim();
    const sourceFile = resolveRepoImportPath(repoFilePath, specifier);
    if (!sourceFile) continue;

    const namedMatch = clause.match(/\{([\s\S]*?)\}/);
    const namedPart = namedMatch?.[1] ?? '';
    const defaultPart = clause.includes('{')
      ? clause.slice(0, clause.indexOf('{')).replace(/,/g, '').trim()
      : clause.trim();

    if (defaultPart && /^[A-Za-z_$][\w$]*$/.test(defaultPart)) {
      bindings.push({
        localName: defaultPart,
        importedName: 'default',
        sourceFile,
      });
    }

    if (namedPart) {
      const items = namedPart.split(',').map((item) => item.trim()).filter(Boolean);
      for (const item of items) {
        const aliasMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliasMatch) {
          bindings.push({
            localName: aliasMatch[2],
            importedName: aliasMatch[1],
            sourceFile,
          });
          continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(item)) {
          bindings.push({
            localName: item,
            importedName: item,
            sourceFile,
          });
        }
      }
    }
  }

  return Array.from(
    new Map(bindings.map((item) => [`${item.localName}|${item.importedName}|${item.sourceFile}`, item])).values()
  );
}


export function buildApiFunctionEndpointMap(repoFilePath: string): Map<string, ApiFunctionEndpointEvidence[]> {
  if (!currentRepoPath) return new Map();
  const absPath = path.join(currentRepoPath, repoFilePath);
  if (!fs.existsSync(absPath)) return new Map();

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return new Map();
  }

  const methodMap = new Map<string, ApiFunctionEndpointEvidence[]>();
  const defPattern = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=)/;
  const requestPattern = /(request|axios)\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/ig;
  const fetchPattern = /fetch\(\s*['"`]([^'"`]+)['"`]/ig;

  const addEndpoint = (functionName: string, method: string, endpoint: string, line: number): void => {
    const arr = methodMap.get(functionName) ?? [];
    arr.push({
      filePath: repoFilePath,
      functionName,
      method,
      endpoint,
      line,
    });
    methodMap.set(functionName, arr);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const defMatch = line.match(defPattern);
    const functionName = (defMatch?.[1] ?? defMatch?.[2] ?? '').trim();
    if (!functionName) continue;

    let endLine = resolveMethodScanEnd(lines, i, 30);
    if (endLine <= i) {
      endLine = Math.min(lines.length - 1, i + 8);
    }

    for (let j = i; j <= endLine; j++) {
      const code = lines[j] ?? '';
      requestPattern.lastIndex = 0;
      let requestMatch: RegExpExecArray | null = null;
      while ((requestMatch = requestPattern.exec(code)) !== null) {
        const method = (requestMatch[2] ?? '').toUpperCase();
        const endpoint = requestMatch[3] ?? '';
        if (!method || !endpoint) continue;
        addEndpoint(functionName, method, endpoint, j + 1);
      }

      fetchPattern.lastIndex = 0;
      let fetchMatch: RegExpExecArray | null = null;
      while ((fetchMatch = fetchPattern.exec(code)) !== null) {
        const endpoint = fetchMatch[1] ?? '';
        if (!endpoint) continue;
        addEndpoint(functionName, 'FETCH', endpoint, j + 1);
      }
    }
  }

  return methodMap;
}
