/**
 * Agent 证据收集层（T1 · P0-A 的前置）——把「模型看过什么」还原成结构化 `Evidence[]`。
 *
 * 为什么需要这一层：`reflectOnAnswer` 的 L1 引用核对被
 * `input.evidence.length > 0` 守卫（见 services/ask/reflection.ts），而 agent 手里只有
 * 字符串工具结果。不补这层就把 reflectOnAnswer 接上去，L1 会**静默跳过**，
 * 只剩要花钱的 L2——看着接上了，其实白接。
 *
 * 语义对齐 ask 侧的 `extractEvidenceFromAnswer(answer, codeContext)`：
 *   - ask：引用取自**答案**，code 取自**模型看到的 codeContext**；
 *   - agent：引用取自**答案**，code 取自**模型看到的工具结果**（本模块建的行索引）。
 * 两边都不是"从磁盘现读一遍"——那样 citationAccuracy 恒等于 1，核对就成了自证。
 * 这里记的是模型**声称看到**的内容，再由 citationAccuracy 拿去和磁盘对峙。
 *
 * agent 侧尤其需要它：`compressMessages` 会折叠早期工具结果，模型很容易凭记忆
 * 报出漂移的行号——这正是 L1 能抓到的典型错误。
 */
import type { Evidence } from '@aiops/shared-types';

/** 一次工具调用的观察记录（agentLoop 在执行工具后累积）。 */
export interface ToolObservation {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
}

/** file → (行号 → 该行文本)：模型通过工具实际看到过的行。 */
export type ToolLineIndex = Map<string, Map<number, string>>;

/** 归一化仓库内相对路径：去掉 ./ 前缀与包裹用的标点。 */
function normalizePath(raw: string): string {
  return raw.trim().replace(/^[`"'(<[]+|[`"')>\],.;:]+$/g, '').replace(/^\.\//, '');
}

/** 可被引用的源码后缀（与图谱支持的语言对齐）。 */
const SOURCE_EXT = /\.(vue|ts|js|tsx|jsx|java|mjs|cjs)$/i;

function addLine(index: ToolLineIndex, file: string, line: number, text: string): void {
  if (!file || !Number.isInteger(line) || line < 1) return;
  let fileMap = index.get(file);
  if (!fileMap) {
    fileMap = new Map();
    index.set(file, fileMap);
  }
  // 先到先得：同一行被多次读到时保留首次看到的文本（后续可能是被压缩过的版本）
  if (!fileMap.has(line)) fileMap.set(line, text.trim());
}

/**
 * 从工具结果里建「模型看过哪些行」的索引。
 *
 * 支持三种带行号的输出格式（其余工具如 find_symbol 只给位置不给正文，
 * 不进索引——引用到那些位置时 code 记为无标识符占位，仍会核对文件/行号是否存在）：
 *   - read_file：      `[path] 共 N 行，显示 a-b:` + `12: text`
 *   - search_in_file： `[path] 共 N 行，匹配 M 处：` + `> 12: text` / `  12: text`
 *   - search_code：    `path:12:text`（rg/grep 原样输出，可能带 ./ 前缀）
 */
export function indexToolObservations(observations: ToolObservation[]): ToolLineIndex {
  const index: ToolLineIndex = new Map();

  for (const obs of observations) {
    const lines = obs.result.split('\n');

    if (obs.toolName === 'read_file' || obs.toolName === 'search_in_file') {
      // 文件名优先取结果头部的回显；取不到再退回入参（入参可能带 ./ 或大小写差异）
      const headerFile = lines[0]?.match(/^\[(.+?)\]\s/)?.[1];
      const file = normalizePath(headerFile ?? String(obs.args.filePath ?? ''));
      if (!file) continue;
      for (const line of lines.slice(1)) {
        // read_file: "12: text"；search_in_file: "> 12: text" / "  12: text"
        const m = line.match(/^[>\s]?\s*(\d+):\s?(.*)$/);
        if (m) addLine(index, file, Number(m[1]), m[2]);
      }
      continue;
    }

    if (obs.toolName === 'search_code') {
      for (const line of lines) {
        // rg/grep：path:12:text —— 路径里不含冒号（Windows 盘符不在本项目场景内）
        const m = line.match(/^([^:\n]+):(\d+):(.*)$/);
        if (!m) continue;
        const file = normalizePath(m[1]);
        if (!SOURCE_EXT.test(file)) continue;
        addLine(index, file, Number(m[2]), m[3]);
      }
    }
  }

  return index;
}

/** 答案里的 file:line 引用上限——与 ask 侧 extractEvidenceFromAnswer 的 12 条对齐。 */
const MAX_EVIDENCE = 12;

/**
 * 没被行索引覆盖的引用的 code 占位。
 * 必须不含任何 ASCII 标识符（路径段也不行）：citationCheck.extractIdentifiers
 * 会把占位里的 latin token 当"声称的标识符"去 ±2 行窗口比对，正确引用会被
 * 近乎随机地判失败（曾致大面积误报→反思重答→行号被降级成「未确认行号」）。
 * 纯中文占位让核对落到宽松分支：只校验文件与行号是否存在。
 */
const CODE_PLACEHOLDER = '（未捕获正文）';

/**
 * 从最终答案里抽出 `file:line` 引用，组装成 `Evidence[]`。
 * code 取模型在工具结果里看到的那一行；没看到过就记占位（见 CODE_PLACEHOLDER），
 * 与 ask 侧同款降级语义，不会因为"没抓到正文"就把答案判成不实。
 */
export function collectAgentEvidence(answer: string, index: ToolLineIndex): Evidence[] {
  if (!answer) return [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();

  // 路径用白名单字符类而非「非空白」排除类：中文答案里引用常被 markdown 加粗
  // （**path:12**）或全角括号（另见（path:12））包住且与中文黏连（中文不打空格），
  // 排除类会把 `**`/`另见（` 一并吃进文件名 → fileExists=false → 正确引用被判编造
  for (const ref of answer.matchAll(/([\w$@./-]+\.[A-Za-z]+):(\d+)/g)) {
    const file = normalizePath(ref[1]);
    if (!SOURCE_EXT.test(file)) continue;
    const line = Number(ref[2]);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const code = index.get(file)?.get(line);
    evidence.push({
      file,
      line,
      code: code || CODE_PLACEHOLDER,
      label: '关键代码',
    });
    if (evidence.length >= MAX_EVIDENCE) break;
  }

  return evidence;
}
