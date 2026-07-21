import path from 'node:path';
import fs from 'node:fs';

// ============================================================
// 路径安全（写侧目标必须是仓库内相对路径）
// 复用 agent/tools.ts 的 resolve+startsWith 惯例，但补两处硬化：
//   1. 显式拒绝绝对路径与 .. 段（不依赖 resolve 兜底，拒绝原因更清晰）
//   2. symlink 逃逸：对最近的已存在祖先做 realpath，确保真实位置仍在仓库内
//      （否则仓库内一个指向 /etc 的软链能骗过纯字符串前缀判断）
// ============================================================

export interface PathSafetyResult {
  ok: boolean;
  /** 校验通过时的绝对路径。 */
  absPath?: string;
  /** 归一化后的仓库内 POSIX 相对路径。 */
  relPath?: string;
  /** 拒绝原因（人读）。 */
  reason?: string;
}

/**
 * 校验"仓库内相对路径"是否为安全的写目标。只做边界判定——目标是否真实存在由
 * 上层（基线读取）判，职责分离。
 */
export function checkRepoRelativePath(repoPath: string, input: string): PathSafetyResult {
  if (!repoPath) return { ok: false, reason: '仓库路径未配置' };
  if (!input) return { ok: false, reason: '路径为空' };

  // 统一成 POSIX 分隔符（顺带挡 Windows 反斜杠 / 盘符）
  const normalizedInput = input.replace(/\\/g, '/').trim();
  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:/.test(normalizedInput)) {
    return { ok: false, reason: `拒绝绝对路径：${input}` };
  }

  // 归一化并显式挡 .. 段（含归一化后仍逃逸的情形，如 a/../../x）
  const relNormalized = path.posix.normalize(normalizedInput).replace(/^\.\//, '');
  if (relNormalized === '..' || relNormalized.startsWith('../')) {
    return { ok: false, reason: `拒绝路径穿越（..）：${input}` };
  }

  const repoRoot = path.resolve(repoPath);
  const absPath = path.resolve(repoRoot, relNormalized);
  // 字符串前缀兜底：resolve 后仍须确认落在根内
  if (absPath !== repoRoot && !absPath.startsWith(repoRoot + path.sep)) {
    return { ok: false, reason: `路径超出仓库范围：${input}` };
  }

  // symlink 逃逸：realpath 最近的已存在祖先，确认真实位置仍在仓库真实根内。
  // 注：指向"不存在目标"的悬空软链此处会漏过，但下游基线读取 / git apply 都会失败，
  // 真正危险的"经软链写到仓库外已存在文件"在这里被挡住。
  const realRepoRoot = safeRealpath(repoRoot) ?? repoRoot;
  const realAncestor = realpathNearestExisting(absPath);
  if (
    realAncestor &&
    realAncestor !== realRepoRoot &&
    !realAncestor.startsWith(realRepoRoot + path.sep)
  ) {
    return { ok: false, reason: `路径经软链逃逸出仓库：${input}` };
  }

  return {
    ok: true,
    absPath,
    relPath: relNormalized.split(path.sep).join('/'),
  };
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** 逐级向上找到第一个真实存在的祖先并 realpath（目标文件可能尚不存在时用于 symlink 判断）。 */
function realpathNearestExisting(absPath: string): string | null {
  let cur = absPath;
  for (let i = 0; i < 4096; i++) {
    const real = safeRealpath(cur);
    if (real) return real;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
