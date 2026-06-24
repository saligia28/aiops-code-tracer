// ============================================================
// 文件扫描 & 代码行模式识别
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import {
  currentRepoPath,
} from '../../context.js';
import { escapeRegex } from './textUtils.js';


export function listFilesRecursively(dir: string, maxDepth: number = 4): string[] {
  const results: string[] = [];
  const walk = (curr: string, depth: number) => {
    if (depth > maxDepth || !fs.existsSync(curr)) return;
    const entries = fs.readdirSync(curr, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(next, depth + 1);
      } else {
        results.push(next);
      }
    }
  };
  walk(dir, 0);
  return results;
}


export function toRepoRelative(absPath: string): string {
  return path.relative(currentRepoPath, absPath).replaceAll(path.sep, '/');
}


const API_CALL_PATTERN = /(request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`][^'"`]+['"`]|axios\.(get|post|put|delete|patch)\s*\(|axios\(|fetch\(\s*['"`][^'"`]+['"`])/i;


const API_ENDPOINT_LITERAL_PATTERN = /['"`](\/[a-z0-9_-]+(?:\/[a-z0-9._-]+){1,})['"`]/i;


export function hasApiSignal(text: string): boolean {
  return API_CALL_PATTERN.test(text) || API_ENDPOINT_LITERAL_PATTERN.test(text);
}


export function findFunctionBoundary(lines: string[], targetLine: number, maxLines: number = 40): { start: number; end: number } {
  const idx = Math.max(0, Math.min(targetLine - 1, lines.length - 1));

  let start = idx;
  const funcDeclPattern = /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(|^\s*(async\s+)?\w+\s*\(.*\)\s*\{|^\s*(export\s+default\s+)?\{|methods\s*:\s*\{|computed\s*:\s*\{|watch\s*:\s*\{/;
  for (let i = idx; i >= Math.max(0, idx - 20); i--) {
    const line = lines[i];
    if (funcDeclPattern.test(line)) {
      start = i;
      break;
    }
  }

  let end = idx;
  let depth = 0;
  let seenOpen = false;
  const maxEnd = Math.min(lines.length - 1, start + maxLines - 1);
  for (let i = start; i <= maxEnd; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (opens > 0) seenOpen = true;
    depth += opens - closes;
    end = i;
    if (seenOpen && depth <= 0) break;
  }

  return { start, end };
}


export function extractMethodNamesFromEventLine(line: string): string[] {
  const methods = new Set<string>();
  const patterns = [
    /handleClick\s*:\s*this\.(\w+)/g,
    /onClick=\{this\.(\w+)\}/g,
    /@click\s*=\s*["'{]\s*([\w$]+)/g,
    /this\.\$refs\.\w+\.(\w+)\s*\(/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null = null;
    while ((m = pattern.exec(line)) !== null) {
      const name = (m[1] ?? '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      methods.add(name);
    }
  }
  return Array.from(methods);
}


export function findMethodDefinitionLine(lines: string[], methodName: string): number {
  if (!methodName) return -1;
  const escaped = escapeRegex(methodName);
  const patterns = [
    new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*:\\s*(?:async\\s*)?function\\s*\\(`),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`\\b${escaped}\\s*=\\s*(?:async\\s*)?function\\s*\\(`),
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (patterns.some((pattern) => pattern.test(line))) return i;
  }
  return -1;
}


export function resolveMethodScanEnd(lines: string[], startLine: number, maxSpan: number = 40): number {
  let depth = 0;
  let seenBlockStart = false;
  const endLimit = Math.min(lines.length - 1, startLine + maxSpan);
  for (let i = startLine; i <= endLimit; i++) {
    const line = lines[i] ?? '';
    const openCount = (line.match(/\{/g) ?? []).length;
    const closeCount = (line.match(/\}/g) ?? []).length;
    if (openCount > 0) seenBlockStart = true;
    depth += openCount - closeCount;
    if (seenBlockStart && i > startLine && depth <= 0) {
      return i;
    }
  }
  return endLimit;
}


export function isMethodRelevantToQuestion(methodName: string, questionLower: string): boolean {
  const name = methodName.toLowerCase();
  if (!name) return false;
  if (/(核实|校验|确认|verify|check)/i.test(questionLower)) {
    return /(verify|check|confirm|inventory|batch)/i.test(name);
  }
  if (/(作废|废弃|void|discard|abolish)/i.test(questionLower)) {
    return /(void|discard|abolish|cancel)/i.test(name);
  }
  if (/(审核|audit|审批)/i.test(questionLower)) {
    return /(audit|approve|review)/i.test(name);
  }
  return /(open|confirm|submit|verify|check|handle|click|batch|void|discard|abolish)/i.test(name);
}
