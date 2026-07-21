// ============================================================
// SEARCH/REPLACE 编辑块解析 + 应用（P2-G1 · 方案 B 的 LLM 契约）
// LLM 不做行号记账，只产出"把这段现有代码换成那段"的锚定编辑（Aider 风格）：
//   <<<<<<< SEARCH file=相对路径
//   <精确的当前若干行>
//   =======
//   <替换后的若干行>
//   >>>>>>> REPLACE
// 我们在内存里定位 + 替换得到新内容，再交 diffSynth 合成 diff、G0 gate 硬校验。
// ============================================================

export interface EditBlock {
  /** SEARCH 行上的 file=；LLM 省略时为 undefined（单文件提案可由上层兜默认）。 */
  file?: string;
  search: string;
  replace: string;
}

const SEARCH_RE = /^<{5,8} SEARCH(?:\s+file=(.+?))?\s*$/;
const SEP_RE = /^={5,8}\s*$/;
const REPLACE_RE = /^>{5,8} REPLACE\s*$/;

/** 从 LLM 原始输出解析出编辑块（容忍块外的散文 / 代码围栏）。 */
export function parseEditBlocks(text: string): EditBlock[] {
  const blocks: EditBlock[] = [];
  let mode: 'idle' | 'search' | 'replace' = 'idle';
  let file: string | undefined;
  let search: string[] = [];
  let replace: string[] = [];

  for (const line of text.split('\n')) {
    if (mode === 'idle') {
      const m = SEARCH_RE.exec(line);
      if (m) {
        mode = 'search';
        file = m[1]?.trim() || undefined;
        search = [];
        replace = [];
      }
      continue;
    }
    if (mode === 'search') {
      if (SEP_RE.test(line)) { mode = 'replace'; continue; }
      search.push(line);
      continue;
    }
    // mode === 'replace'
    if (REPLACE_RE.test(line)) {
      blocks.push({ file, search: search.join('\n'), replace: replace.join('\n') });
      mode = 'idle';
      continue;
    }
    replace.push(line);
  }
  return blocks;
}

/** 按 file 归组（无 file 的块归到 defaultFile）。 */
export function groupEditsByFile(blocks: EditBlock[], defaultFile?: string): Map<string, EditBlock[]> {
  const byFile = new Map<string, EditBlock[]>();
  for (const b of blocks) {
    const key = b.file ?? defaultFile;
    if (!key) continue; // 无 file 又无默认：上层判为无效
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(b);
  }
  return byFile;
}

export interface ApplyResult {
  ok: boolean;
  content?: string;
  error?: string;
}

const preview = (s: string): string => {
  const oneLine = s.replace(/\n/g, '⏎');
  return oneLine.length > 40 ? oneLine.slice(0, 40) + '…' : oneLine;
};

/**
 * 依次把编辑应用到单文件原文。要求 SEARCH 在当前内容里"唯一精确匹配"——
 * 找不到 / 多处匹配都拒绝并给可反馈的原因（交由上层塞回下一轮重生成），
 * 绝不模糊匹配（模糊匹配是"改错地方"的温床）。
 */
export function applyEditsToFile(original: string, edits: EditBlock[]): ApplyResult {
  let content = original;
  for (let i = 0; i < edits.length; i++) {
    const ed = edits[i];
    if (ed.search === '') {
      return { ok: false, error: `第 ${i + 1} 个编辑 SEARCH 为空（需锚定现有代码）` };
    }
    const first = content.indexOf(ed.search);
    if (first === -1) {
      return { ok: false, error: `第 ${i + 1} 个编辑 SEARCH 未在当前内容找到：${preview(ed.search)}` };
    }
    if (content.indexOf(ed.search, first + 1) !== -1) {
      return { ok: false, error: `第 ${i + 1} 个编辑 SEARCH 有多处匹配，需更多上下文：${preview(ed.search)}` };
    }
    content = content.slice(0, first) + ed.replace + content.slice(first + ed.search.length);
  }
  return { ok: true, content };
}
