// ============================================================
// 统一 diff 解析 + v1 策略
// 目标不是通用 patch 库，而是够用地识别：每段涉及哪个文件、什么操作、几个 hunk，
// 供策略层做硬拒绝（v1 只允许"修改已声明的文本文件"）。
// ============================================================

export type DiffOp = 'modify' | 'add' | 'delete' | 'rename' | 'copy';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ParsedDiffFile {
  /** 旧路径（/dev/null → null，如新增文件）。 */
  oldPath: string | null;
  /** 新路径（/dev/null → null，如删除文件）。 */
  newPath: string | null;
  op: DiffOp;
  isBinary: boolean;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
}

/** 去 a/ b/ 前缀；git 对带空格路径会加引号，v1 只处理常见未引用情形。 */
function stripPrefix(p: string): string | null {
  const trimmed = p.trim();
  if (trimmed === '/dev/null') return null;
  return trimmed.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

/**
 * 解析统一 diff。关键正确性点：进入 hunk 正文后不再解析文件头——因为一条被删除的
 * 内容行可能形如 "--- foo"（"-" 标记 + "-- foo"），naive 前缀判断会把它误当文件头。
 * 而 "diff --git" / 内容行的 "@@" 一定带 +/-/空格 前导标记，不会与段首 col0 冲突。
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split('\n');
  const files: ParsedDiffFile[] = [];
  let cur: ParsedDiffFile | null = null;
  let inBody = false; // 是否已进入某文件的 hunk 正文

  for (const line of lines) {
    // 段边界：只有 col0 的 "diff --git " 才是新文件（内容行带前导标记，不会命中）
    if (line.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      cur = { oldPath: null, newPath: null, op: 'modify', isBinary: false, hunks: [] };
      inBody = false;
      const m = line.match(/^diff --git (\S+) (\S+)$/);
      if (m) {
        cur.oldPath = stripPrefix(m[1]);
        cur.newPath = stripPrefix(m[2]);
      }
      continue;
    }
    if (!cur) continue;

    // hunk 头（col0 "@@ -a,b +c,d @@"）——每个 @@ 是一个新 hunk，进入正文模式
    if (line.startsWith('@@')) {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h) {
        cur.hunks.push({
          oldStart: Number(h[1]),
          oldLines: h[2] === undefined ? 1 : Number(h[2]),
          newStart: Number(h[3]),
          newLines: h[4] === undefined ? 1 : Number(h[4]),
        });
        inBody = true;
      }
      continue;
    }

    // 正文里的行一律不当文件头解析（见函数注释）
    if (inBody) continue;

    // 文件头模式（首个 @@ 之前）
    if (line.startsWith('new file mode')) { cur.op = 'add'; continue; }
    if (line.startsWith('deleted file mode')) { cur.op = 'delete'; continue; }
    if (line.startsWith('rename from') || line.startsWith('rename to')) { cur.op = 'rename'; continue; }
    if (line.startsWith('copy from') || line.startsWith('copy to')) { cur.op = 'copy'; continue; }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) { cur.isBinary = true; continue; }
    if (line.startsWith('--- ')) { cur.oldPath = stripPrefix(line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { cur.newPath = stripPrefix(line.slice(4)); continue; }
  }
  if (cur) files.push(cur);
  return { files };
}

// ============================================================
// v1 策略层
// ============================================================

export interface DiffPolicyLimits {
  maxFiles: number;
  maxHunks: number;
  maxBytes: number;
}

/** v1 默认上限（保守，后续可 env 化）。 */
export const DEFAULT_DIFF_LIMITS: DiffPolicyLimits = {
  maxFiles: 10,
  maxHunks: 40,
  maxBytes: 64 * 1024,
};

export type DiffPolicyRejectCode =
  | 'DIFF_EMPTY'
  | 'DIFF_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'TOO_MANY_HUNKS'
  | 'DISALLOWED_OP'
  | 'UNLISTED_FILE';

export interface DiffPolicyReject {
  code: DiffPolicyRejectCode;
  detail: string;
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * v1 策略：只允许"修改已声明的文本文件"。挡掉一切增/删/改名/拷贝/二进制，挡掉 diff
 * 触碰未在 allowedFiles 声明的文件（防越界写），并对文件数 / hunk 数 / 字节数封顶。
 * 返回 null 表示通过；否则给出第一个违规原因。
 */
export function enforceModifyOnlyPolicy(
  diff: string,
  parsed: ParsedDiff,
  allowedFiles: string[],
  limits: DiffPolicyLimits = DEFAULT_DIFF_LIMITS,
): DiffPolicyReject | null {
  if (!diff.trim() || parsed.files.length === 0) {
    return { code: 'DIFF_EMPTY', detail: 'diff 为空或无可识别文件段' };
  }
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes > limits.maxBytes) {
    return { code: 'DIFF_TOO_LARGE', detail: `diff ${bytes}B 超过上限 ${limits.maxBytes}B` };
  }
  if (parsed.files.length > limits.maxFiles) {
    return { code: 'TOO_MANY_FILES', detail: `${parsed.files.length} 个文件超过上限 ${limits.maxFiles}` };
  }

  const allowed = new Set(allowedFiles.map(normalizePosix));
  let totalHunks = 0;
  for (const f of parsed.files) {
    const label = f.newPath ?? f.oldPath ?? '(未知路径)';
    if (f.isBinary) return { code: 'DISALLOWED_OP', detail: `二进制改动不允许：${label}` };
    if (f.op !== 'modify') {
      return { code: 'DISALLOWED_OP', detail: `v1 只允许修改已有文件，拒绝 ${f.op}：${label}` };
    }
    // modify 段：新旧路径须一致且非 /dev/null
    if (!f.oldPath || !f.newPath || f.oldPath !== f.newPath) {
      return { code: 'DISALLOWED_OP', detail: `修改段路径异常：${f.oldPath} → ${f.newPath}` };
    }
    if (!allowed.has(normalizePosix(f.newPath))) {
      return { code: 'UNLISTED_FILE', detail: `diff 触碰未声明文件：${f.newPath}` };
    }
    totalHunks += f.hunks.length;
  }
  if (totalHunks > limits.maxHunks) {
    return { code: 'TOO_MANY_HUNKS', detail: `${totalHunks} 个 hunk 超过上限 ${limits.maxHunks}` };
  }
  return null;
}
