import fs from 'node:fs';
import { checkRepoRelativePath } from './pathSafety.js';
import { sha256OfBytes } from './baseline.js';
import { gitApplyCheck, gitApply } from './gitApplyCheck.js';
import {
  getProposal,
  markApplied,
  markRolledBack,
  appendAudit,
  type ProposalSnapshotEntry,
} from '../../db/patchStore.js';

// ============================================================
// 确定性 apply / rollback 核心（P2-G 第二刀 · 审批门的落盘逻辑）
// 这是系统第一次真的写被分析仓库。安全靠三道闸：
//   1. 落盘前重校验基线哈希（堵"生成→审批"时间窗——文件变了就拒，绝不基于旧内容改）
//   2. 再跑一次 git apply --check（belt-and-suspenders）
//   3. 落盘前存原始字节快照 → 回滚无条件写回（不依赖 git 状态）
// 回滚前做漂移检测：落盘后被人动过就拒绝回滚，绝不覆盖未知改动。
// 权限（env 开关）与人工二次确认在路由层，这里只管落盘逻辑。
// ============================================================

/** 单文件快照上限：防病态大文件把库撑爆（base64 还会膨胀 33%）。 */
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export type ApplyReject =
  | 'NOT_FOUND'
  | 'BAD_STATUS'
  | 'PATH_UNSAFE'
  | 'FILE_MISSING'
  | 'FILE_TOO_LARGE'
  | 'BASELINE_MISMATCH'
  | 'GIT_APPLY_FAILED';

export type ApplyOutcome =
  | { ok: true; appliedFiles: string[] }
  | { ok: false; reason: ApplyReject; detail: string };

function applyFail(proposalId: string, reason: ApplyReject, detail: string): ApplyOutcome {
  // 记审计（含前置校验失败）：'基线变化时 apply 被拒' 要有审计佐证
  try {
    appendAudit(proposalId, 'apply_rejected', 'error', `${reason}: ${detail}`);
  } catch {
    /* proposalId 不存在等极端情况：审计写不进就算了，不影响拒绝结果 */
  }
  return { ok: false, reason, detail };
}

export async function applyPatch(proposalId: string, repoPath: string): Promise<ApplyOutcome> {
  const p = getProposal(proposalId);
  if (!p) return applyFail(proposalId, 'NOT_FOUND', `提案不存在：${proposalId}`);
  if (p.status !== 'proposed') return applyFail(proposalId, 'BAD_STATUS', `提案状态为 ${p.status}，不可 apply`);

  // 1. 落盘前逐文件重校验 + 读原始字节（快照素材）
  const originals: Record<string, Buffer> = {};
  for (const f of p.files) {
    const safe = checkRepoRelativePath(repoPath, f.file);
    if (!safe.ok || !safe.absPath) return applyFail(proposalId, 'PATH_UNSAFE', safe.reason ?? f.file);
    let buf: Buffer;
    try {
      const st = fs.statSync(safe.absPath);
      if (!st.isFile()) return applyFail(proposalId, 'FILE_MISSING', `不是文件：${f.file}`);
      buf = fs.readFileSync(safe.absPath);
    } catch {
      return applyFail(proposalId, 'FILE_MISSING', `文件不存在或不可读：${f.file}`);
    }
    if (buf.length > MAX_SNAPSHOT_BYTES) return applyFail(proposalId, 'FILE_TOO_LARGE', `文件过大无法安全快照：${f.file}`);
    // 核心闸：文件当前字节必须仍等于提案基线，否则提案基于旧内容，拒绝落盘
    if (sha256OfBytes(buf) !== f.baselineSha256) {
      return applyFail(proposalId, 'BASELINE_MISMATCH', `文件已变（提案基于旧内容）：${f.file}`);
    }
    originals[f.file] = buf;
  }

  // 2. 再跑一次 git apply --check（时间窗兜底）
  const check = await gitApplyCheck(repoPath, p.unifiedDiff);
  if (!check.ok) return applyFail(proposalId, 'GIT_APPLY_FAILED', check.stderr || `--check 退出码 ${check.code}`);

  // 3. 真·落盘
  const applied = await gitApply(repoPath, p.unifiedDiff);
  if (!applied.ok) return applyFail(proposalId, 'GIT_APPLY_FAILED', applied.stderr || `apply 退出码 ${applied.code}`);

  // 4. 落盘后读取，记 appliedSha256（回滚漂移检测锚），连同原始字节存快照
  const snapshot: Record<string, ProposalSnapshotEntry> = {};
  for (const f of p.files) {
    const safe = checkRepoRelativePath(repoPath, f.file);
    const after = safe.absPath && fs.existsSync(safe.absPath) ? fs.readFileSync(safe.absPath) : null;
    snapshot[f.file] = {
      originalBase64: originals[f.file].toString('base64'),
      appliedSha256: after ? sha256OfBytes(after) : '',
    };
  }

  markApplied(proposalId, snapshot, Date.now());
  appendAudit(proposalId, 'apply', 'ok', `已落盘 ${p.files.length} 个文件`);
  return { ok: true, appliedFiles: p.files.map((f) => f.file) };
}

export type RollbackReject = 'NOT_FOUND' | 'BAD_STATUS' | 'NO_SNAPSHOT' | 'PATH_UNSAFE' | 'DRIFT_SINCE_APPLY';

export type RollbackOutcome =
  | { ok: true; restoredFiles: string[] }
  | { ok: false; reason: RollbackReject; detail: string };

function rollbackFail(proposalId: string, reason: RollbackReject, detail: string): RollbackOutcome {
  try {
    appendAudit(proposalId, 'rollback_rejected', 'error', `${reason}: ${detail}`);
  } catch {
    /* 同上 */
  }
  return { ok: false, reason, detail };
}

export async function rollbackPatch(proposalId: string, repoPath: string): Promise<RollbackOutcome> {
  const p = getProposal(proposalId);
  if (!p) return rollbackFail(proposalId, 'NOT_FOUND', `提案不存在：${proposalId}`);
  if (p.status !== 'applied') return rollbackFail(proposalId, 'BAD_STATUS', `提案状态为 ${p.status}，不可回滚`);
  if (!p.snapshot) return rollbackFail(proposalId, 'NO_SNAPSHOT', '无快照，无法回滚');
  const snapshot = p.snapshot;

  // 漂移检测：落盘后文件若被人动过（sha ≠ 落盘态），拒绝回滚——绝不覆盖未知改动
  const targets: Array<{ file: string; absPath: string }> = [];
  for (const f of p.files) {
    const safe = checkRepoRelativePath(repoPath, f.file);
    if (!safe.ok || !safe.absPath) return rollbackFail(proposalId, 'PATH_UNSAFE', safe.reason ?? f.file);
    const snap = snapshot[f.file];
    const cur = fs.existsSync(safe.absPath) ? fs.readFileSync(safe.absPath) : null;
    if (!snap || !cur || sha256OfBytes(cur) !== snap.appliedSha256) {
      return rollbackFail(proposalId, 'DRIFT_SINCE_APPLY', `落盘后文件被改动，拒绝回滚以免覆盖：${f.file}`);
    }
    targets.push({ file: f.file, absPath: safe.absPath });
  }

  // 写回原始字节（无条件成功，不依赖 git）
  for (const t of targets) {
    fs.writeFileSync(t.absPath, Buffer.from(snapshot[t.file].originalBase64, 'base64'));
  }

  markRolledBack(proposalId, Date.now());
  appendAudit(proposalId, 'rollback', 'ok', `已回滚 ${p.files.length} 个文件`);
  return { ok: true, restoredFiles: p.files.map((f) => f.file) };
}
