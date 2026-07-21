import { checkRepoRelativePath } from './pathSafety.js';
import { sha256OfFile } from './baseline.js';
import { parseUnifiedDiff, enforceModifyOnlyPolicy, DEFAULT_DIFF_LIMITS } from './diffParser.js';
import { gitApplyCheck } from './gitApplyCheck.js';
import type { PatchProposal, PatchValidation, ValidateOptions, PatchRejectCode } from './types.js';

// ============================================================
// 纯确定性校验器（不接 LLM）
// 把"看起来结构化"变成"可应用且未越界"。全程只读仓库，绝不写盘。
// ============================================================

function reject(
  reason: PatchRejectCode,
  detail: string,
  baselines: PatchValidation['baselines'] = [],
): PatchValidation {
  return { ok: false, reason, detail, baselines };
}

/**
 * 校验步骤（任一步失败即短路）：
 *   1. diff 策略：只改已声明文本文件、封顶（文件数 / hunk 数 / 字节数）
 *   2. 路径安全：仓库内相对路径，挡 .. / 绝对 / symlink 逃逸
 *   3. 基线锚定：每个文件当前字节 sha256 必须等于提案基线（防基于旧内容改新文件）
 *   4. git apply --check 硬 gate（stdin，不落盘）
 *   5. 竞态复检：gate 后再算一次基线，确保校验期间文件没被改
 */
export async function validateProposal(
  proposal: PatchProposal,
  repoPath: string,
  opts: ValidateOptions = {},
): Promise<PatchValidation> {
  const limits = opts.limits ?? DEFAULT_DIFF_LIMITS;

  // 1. diff 解析 + v1 策略
  const parsed = parseUnifiedDiff(proposal.unifiedDiff);
  const allowedFiles = proposal.files.map((f) => f.file);
  const policy = enforceModifyOnlyPolicy(proposal.unifiedDiff, parsed, allowedFiles, limits);
  if (policy) return reject(policy.code, policy.detail);

  // 2 + 3. 逐文件：路径安全 + 基线锚定
  const baselines: PatchValidation['baselines'] = [];
  for (const f of proposal.files) {
    const safe = checkRepoRelativePath(repoPath, f.file);
    if (!safe.ok || !safe.absPath) return reject('PATH_UNSAFE', safe.reason ?? f.file, baselines);

    const current = sha256OfFile(safe.absPath);
    baselines.push({ file: f.file, sha256: current });
    if (current === null) return reject('FILE_MISSING', `目标文件不存在或不可读：${f.file}`, baselines);
    if (current !== f.baselineSha256) {
      return reject('BASELINE_MISMATCH', `文件已变（提案基于旧内容）：${f.file}`, baselines);
    }
  }

  // 4. git apply --check 硬 gate
  const applied = await gitApplyCheck(repoPath, proposal.unifiedDiff, { timeoutMs: opts.gitTimeoutMs });
  if (!applied.ok) {
    return reject('GIT_APPLY_FAILED', applied.stderr || `git apply --check 退出码 ${applied.code}`, baselines);
  }

  // 5. 竞态复检：生成→校验存在时间窗，校验期间文件不能被改
  for (const f of proposal.files) {
    const safe = checkRepoRelativePath(repoPath, f.file);
    const after = safe.absPath ? sha256OfFile(safe.absPath) : null;
    if (after !== f.baselineSha256) {
      return reject('RACE_DETECTED', `校验期间文件被改：${f.file}`, baselines);
    }
  }

  return { ok: true, baselines };
}
