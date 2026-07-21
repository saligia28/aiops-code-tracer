// ============================================================
// 内存 unified diff 合成（P2-G1 · 方案 B 的地基）
// 从 (oldText, newText) 合成 git 可应用的 unified diff。因为 oldText 是文件的精确当前
// 字节、上下文行按构造与工作树一致——git apply --check 从"主过滤器"降为"安全网"，
// 直击 LLM 最不擅长的 @@ 行号记账。不引第三方 diff 依赖（与仓库极简 deps 风格一致）。
// ============================================================

const DEFAULT_CONTEXT = 3;

interface LineFile {
  lines: string[];
  /** 文件是否以换行结尾（决定 "\ No newline at end of file" 标记）。 */
  finalNewline: boolean;
}

/** 拆行：把"是否有末尾换行"与"行内容"分开，避免 split('\n') 的尾部空串伪影。 */
function toLines(text: string): LineFile {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), finalNewline };
}

type OpType = 'eq' | 'del' | 'ins';
interface EnrichedOp {
  t: OpType;
  line: string;
  oldNo: number; // 1-based；ins 行为 0
  newNo: number; // 1-based；del 行为 0
}

/** LCS 行级 diff → 顺序 op 序列（valid 即可，不追求与 git Myers 逐字节一致）。 */
function diffLines(a: string[], b: string[]): Array<{ t: OpType; line: string }> {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i:] 与 b[j:] 的最长公共子序列长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ t: OpType; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'eq', line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: 'del', line: a[i] }); i++; }
    else { ops.push({ t: 'ins', line: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: 'del', line: a[i++] });
  while (j < m) ops.push({ t: 'ins', line: b[j++] });
  return ops;
}

/**
 * 合成一个文件的 unified diff（含 `diff --git` 头，-p1 风格）。无改动返回空串。
 * @param context 每个 hunk 上下文行数（默认 3，与 git 一致）
 */
export function synthUnifiedDiff(
  oldText: string,
  newText: string,
  filePath: string,
  context = DEFAULT_CONTEXT,
): string {
  if (oldText === newText) return '';
  const oldF = toLines(oldText);
  const newF = toLines(newText);
  const rawOps = diffLines(oldF.lines, newF.lines);

  // 标注 1-based 行号
  let oldNo = 1;
  let newNo = 1;
  const en: EnrichedOp[] = rawOps.map((op) => {
    if (op.t === 'eq') return { ...op, oldNo: oldNo++, newNo: newNo++ };
    if (op.t === 'del') return { ...op, oldNo: oldNo++, newNo: 0 };
    return { ...op, oldNo: 0, newNo: newNo++ };
  });

  // 把变更 op 聚成 hunk：相隔 ≤ 2*context 个 eq 行则并入同一 hunk
  const changeIdx = en.map((e, k) => (e.t !== 'eq' ? k : -1)).filter((k) => k >= 0);
  if (changeIdx.length === 0) return '';
  const clusters: Array<{ s: number; e: number }> = [];
  for (const k of changeIdx) {
    const last = clusters[clusters.length - 1];
    if (last && k - last.e - 1 <= 2 * context) last.e = k;
    else clusters.push({ s: k, e: k });
  }

  const oldLastNo = oldF.lines.length; // 末行的 1-based oldNo
  const newLastNo = newF.lines.length;
  const out: string[] = [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`];

  for (const c of clusters) {
    const start = Math.max(0, c.s - context);
    const end = Math.min(en.length - 1, c.e + context);
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    for (let k = start; k <= end; k++) {
      const e = en[k];
      if (e.t === 'eq' || e.t === 'del') { if (oldStart === 0) oldStart = e.oldNo; oldCount++; }
      if (e.t === 'eq' || e.t === 'ins') { if (newStart === 0) newStart = e.newNo; newCount++; }
    }
    out.push(`@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`);
    for (let k = start; k <= end; k++) {
      const e = en[k];
      out.push((e.t === 'eq' ? ' ' : e.t === 'del' ? '-' : '+') + e.line);
      // 末行无换行标记：只在相关版本确实缺末尾换行时补
      const oldIsLast = (e.t === 'eq' || e.t === 'del') && e.oldNo === oldLastNo;
      const newIsLast = (e.t === 'eq' || e.t === 'ins') && e.newNo === newLastNo;
      const needMarker =
        (e.t === 'del' && oldIsLast && !oldF.finalNewline) ||
        (e.t === 'ins' && newIsLast && !newF.finalNewline) ||
        (e.t === 'eq' && oldIsLast && newIsLast && !oldF.finalNewline && !newF.finalNewline);
      if (needMarker) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}
