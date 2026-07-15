/**
 * 引用核对（L2）—— 确定性校验答案引用的 file:line 是否真实存在且与声称内容匹配。
 *
 * 从 test/eval/citation.ts 迁入 src：P0-A 的「自校验进循环」要在生产链路里跑它，
 * 而 build 只打包 src/；test/eval/citation.ts 现在是本模块的 re-export 壳。
 *
 * 三级判定（逐级收紧）：
 *   fileExists → lineExists → matched（声称的标识符在该行 ±GRACE 行内出现）
 * 全程只读磁盘、无 LLM、毫秒级——适合放在每次回答后内联执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence } from '@aiops/shared-types';

export interface CitationCheck {
  evidence: Evidence;
  fileExists: boolean;
  lineExists: boolean;
  /** 引用行的实际文本（lineExists 时有值），供人工复核。 */
  actualLine?: string;
  matched: boolean;
}

export interface CitationResult {
  /**
   * matched 数 / evidence 总数。
   * 约定：空 evidence 返回 1（"引用准确率"衡量的是给出的引用里有多少是真的；
   * 一条没给=没说错话=空真。"该引用却没引用"是另一个指标，别混在这里）。
   */
  accuracy: number;
  checks: CitationCheck[];
}

/** 行号容差：声称第 N 行，实际在 N±GRACE 内命中标识符也算 matched。 */
const GRACE = 2;

/** 从 evidence.code 提取标识符 token（≥3 字符，排除类型标签等噪声词）。 */
const IGNORE = new Set(['function', 'variable', 'component', 'computed', 'import', 'file', 'apicall', 'const', 'async', 'await', 'return', 'export', 'default']);
function extractIdentifiers(code: string): string[] {
  return (code.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])
    .filter((t) => !IGNORE.has(t.toLowerCase()))
    .slice(0, 8);
}

function checkOne(e: Evidence, lines: string[] | null): CitationCheck {
  if (!lines) {
    return { evidence: e, fileExists: false, lineExists: false, matched: false };
  }
  const lineExists = Number.isInteger(e.line) && e.line >= 1 && e.line <= lines.length;
  if (!lineExists) {
    return { evidence: e, fileExists: true, lineExists: false, matched: false };
  }
  const actualLine = lines[e.line - 1];

  const idents = extractIdentifiers(e.code);
  if (idents.length === 0) {
    // 引用没声称任何具体标识符（如纯中文标签）→ 行存在即视为匹配。
    return { evidence: e, fileExists: true, lineExists: true, actualLine, matched: true };
  }

  const from = Math.max(0, e.line - 1 - GRACE);
  const to = Math.min(lines.length, e.line + GRACE);
  const windowText = lines.slice(from, to).join('\n');
  const matched = idents.some((id) => windowText.includes(id));
  return { evidence: e, fileExists: true, lineExists: true, actualLine, matched };
}

/**
 * 逐条核对 evidence 的 file:line。
 * @param repoPath 被分析仓库的磁盘绝对路径（= context.currentRepoPath）
 */
export function citationAccuracy(evidence: Evidence[], repoPath: string): CitationResult {
  if (evidence.length === 0) return { accuracy: 1, checks: [] };

  const fileCache = new Map<string, string[] | null>();
  const readLines = (rel: string): string[] | null => {
    if (fileCache.has(rel)) return fileCache.get(rel)!;
    let lines: string[] | null = null;
    try {
      lines = fs.readFileSync(path.join(repoPath, rel), 'utf-8').split(/\r?\n/);
    } catch {
      lines = null;
    }
    fileCache.set(rel, lines);
    return lines;
  };

  const checks = evidence.map((e) => checkOne(e, readLines(e.file)));
  const matchedCount = checks.filter((c) => c.matched).length;
  return { accuracy: matchedCount / evidence.length, checks };
}
