import crypto from 'node:crypto';
import { getDb } from './sqlite.js';

// ============================================================
// 补丁提案 + 落盘审计的持久化（P2-G 第二刀 · apply/HITL）
// propose 成功即落库（status=proposed）；apply 按 id 审批——审批的正是校验过的原件。
// snapshot 在 apply 时写入（原始字节 base64 + 落盘后 sha），回滚据此写回并做漂移检测。
// ============================================================

export type ProposalStatus = 'proposed' | 'applied' | 'rolled_back';

export interface StoredProposalFile {
  file: string;
  baselineSha256: string;
  reason: string;
}

/** 每个被改文件的回滚快照：apply 时读到的原始字节 + 落盘后 sha（回滚前漂移检测用）。 */
export interface ProposalSnapshotEntry {
  originalBase64: string;
  appliedSha256: string;
}

export interface StoredProposal {
  id: string;
  repoName: string;
  question: string;
  unifiedDiff: string;
  files: StoredProposalFile[];
  verifyCommands: string[];
  status: ProposalStatus;
  validatedAt: string;
  createdAt: number;
  appliedAt: number | null;
  rolledBackAt: number | null;
  snapshot: Record<string, ProposalSnapshotEntry> | null;
}

export interface AuditEntry {
  id: string;
  proposalId: string;
  action: string;
  result: string;
  detail: string | null;
  at: number;
}

interface ProposalRow {
  id: string;
  repo_name: string;
  question: string;
  unified_diff: string;
  files_json: string;
  verify_json: string;
  status: ProposalStatus;
  validated_at: string;
  created_at: number;
  applied_at: number | null;
  rolled_back_at: number | null;
  snapshot_json: string | null;
}

function rowToProposal(r: ProposalRow): StoredProposal {
  return {
    id: r.id,
    repoName: r.repo_name,
    question: r.question,
    unifiedDiff: r.unified_diff,
    files: JSON.parse(r.files_json) as StoredProposalFile[],
    verifyCommands: JSON.parse(r.verify_json) as string[],
    status: r.status,
    validatedAt: r.validated_at,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
    rolledBackAt: r.rolled_back_at,
    snapshot: r.snapshot_json ? (JSON.parse(r.snapshot_json) as Record<string, ProposalSnapshotEntry>) : null,
  };
}

export interface InsertProposalInput {
  id: string;
  repoName: string;
  question: string;
  unifiedDiff: string;
  files: StoredProposalFile[];
  verifyCommands: string[];
  validatedAt: string;
}

/** propose 成功后落库（status=proposed）。 */
export function insertProposal(p: InsertProposalInput): void {
  getDb()
    .prepare(
      `INSERT INTO patch_proposals (id, repo_name, question, unified_diff, files_json, verify_json, status, validated_at, created_at)
       VALUES (@id, @repoName, @question, @unifiedDiff, @filesJson, @verifyJson, 'proposed', @validatedAt, @createdAt)`,
    )
    .run({
      id: p.id,
      repoName: p.repoName,
      question: p.question,
      unifiedDiff: p.unifiedDiff,
      filesJson: JSON.stringify(p.files),
      verifyJson: JSON.stringify(p.verifyCommands),
      validatedAt: p.validatedAt,
      createdAt: Date.now(),
    });
}

export function getProposal(id: string): StoredProposal | null {
  const row = getDb().prepare('SELECT * FROM patch_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
  return row ? rowToProposal(row) : null;
}

/** 落盘成功：写快照 + 置 applied。 */
export function markApplied(id: string, snapshot: Record<string, ProposalSnapshotEntry>, appliedAt: number): void {
  getDb()
    .prepare(`UPDATE patch_proposals SET status = 'applied', snapshot_json = ?, applied_at = ? WHERE id = ?`)
    .run(JSON.stringify(snapshot), appliedAt, id);
}

/** 回滚成功：置 rolled_back。 */
export function markRolledBack(id: string, rolledBackAt: number): void {
  getDb()
    .prepare(`UPDATE patch_proposals SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?`)
    .run(rolledBackAt, id);
}

export function appendAudit(proposalId: string, action: string, result: string, detail?: string): void {
  getDb()
    .prepare(
      `INSERT INTO patch_apply_audit (id, proposal_id, action, result, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), proposalId, action, result, detail ?? null, Date.now());
}

export function getAudit(proposalId: string): AuditEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM patch_apply_audit WHERE proposal_id = ? ORDER BY at, rowid')
    .all(proposalId) as Array<{ id: string; proposal_id: string; action: string; result: string; detail: string | null; at: number }>;
  return rows.map((r) => ({ id: r.id, proposalId: r.proposal_id, action: r.action, result: r.result, detail: r.detail, at: r.at }));
}
