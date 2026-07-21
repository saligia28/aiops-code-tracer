import type { DiffPolicyLimits } from './diffParser.js';

// ============================================================
// Proposal v1 契约（P2-G 第一刀 · 只读提案，不落盘）
// 设计原则：unifiedDiff 是唯一可执行载荷，"改哪些文件/几个 hunk"一律从 diff 解析，
// 不另存一份可能与 diff 冲突的结构化副本（两份改动内容互相矛盾是灾难源头）。
// ============================================================

/** 提案里每个被改文件的元数据。baselineSha256 是"生成提案时读到的当前字节"的锚点。 */
export interface PatchFileChange {
  /** 仓库内 POSIX 相对路径（与 diff 中的路径一致）。 */
  file: string;
  /** 生成提案时该文件原始字节的 sha256（十六进制，无换行归一化）。 */
  baselineSha256: string;
  /** 为什么改这个文件（供人审）。 */
  reason: string;
  /** 证据引用，v1 透传不解释（来源见读侧 explain/prepare_fix_context）。 */
  evidenceRefs?: unknown[];
}

/** 只读修改提案。停在人工审批之前——没有 apply 端点即没有写盘路径。 */
export interface PatchProposal {
  proposalId: string;
  repoName: string;
  /** 触发本提案的自然语言诉求。 */
  question: string;
  /** 统一 diff（git 风格），唯一可执行载荷。 */
  unifiedDiff: string;
  /** 每个被改文件一条（与 diff 触碰的文件集一致）。 */
  files: PatchFileChange[];
  /** 建议的验证命令（只建议，不执行）。 */
  verifyCommands: string[];
  /** ISO 时间；校验通过时由服务端盖章。 */
  validatedAt: string;
}

/** 校验拒绝码。前 6 个来自 diff 策略层，后 5 个来自路径/基线/gate/竞态。 */
export type PatchRejectCode =
  | 'DIFF_EMPTY'
  | 'DIFF_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'TOO_MANY_HUNKS'
  | 'DISALLOWED_OP'
  | 'UNLISTED_FILE'
  | 'PATH_UNSAFE'
  | 'FILE_MISSING'
  | 'BASELINE_MISMATCH'
  | 'GIT_APPLY_FAILED'
  | 'RACE_DETECTED';

export interface PatchValidation {
  ok: boolean;
  /** 失败时的拒绝码；成功时不存在。 */
  reason?: PatchRejectCode;
  /** 失败细节（已截断的 git stderr / 人读原因）。 */
  detail?: string;
  /** 校验期间重新读到的各文件基线（供审批门二次锚定；sha256 为 null 表示文件缺失）。 */
  baselines: Array<{ file: string; sha256: string | null }>;
}

export interface ValidateOptions {
  limits?: DiffPolicyLimits;
  gitTimeoutMs?: number;
}
