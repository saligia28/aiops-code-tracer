import fs from 'node:fs';
import { checkRepoRelativePath } from './pathSafety.js';
import { sha256OfBytes } from './baseline.js';
import { parseEditBlocks, groupEditsByFile, applyEditsToFile } from './editBlocks.js';
import { synthUnifiedDiff } from './diffSynth.js';
import { validateProposal } from './validateProposal.js';
import { buildProposeMessages } from './prompt.js';
import { DEFAULT_DIFF_LIMITS } from './diffParser.js';
import type { PatchProposal } from './types.js';

// ============================================================
// propose_patch 编排（P2-G1）——LLM 首次入场处，但严格停在人工审批之前
// 流程：读当前字节 → LLM 出 SEARCH/REPLACE → 内存应用得新内容 → synth diff →
// G0 确定性 gate 硬校验 → 失败把原因塞回下一轮（有界重试）→ 终仍失败 PATCH_NOT_APPLICABLE。
// LLM/时间/id 全部依赖注入：编排逻辑（解析/应用/gate/重试）可离线确定性测试。
// ============================================================

export interface ProposePatchInput {
  question: string;
  files: string[];
  repoName: string;
  evidenceRefs?: unknown[];
}

export type ProposePatchOutcome =
  | { ok: true; proposal: PatchProposal; attempts: number }
  | {
      ok: false;
      error: 'INVALID_INPUT' | 'LLM_UNAVAILABLE' | 'NO_CHANGE' | 'PATCH_NOT_APPLICABLE';
      detail: string;
      attempts: number;
    };

type LlmFn = (
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
) => Promise<string | null>;

export interface ProposeDeps {
  llm: LlmFn;
  now: () => string; // ISO 时间戳（validatedAt）
  newId: () => string; // proposalId
  maxAttempts?: number;
  signal?: AbortSignal;
}

const MAX_TARGET_FILES = DEFAULT_DIFF_LIMITS.maxFiles;

const normalizeRel = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

export async function proposePatch(
  input: ProposePatchInput,
  repoPath: string,
  deps: ProposeDeps,
): Promise<ProposePatchOutcome> {
  const maxAttempts = deps.maxAttempts ?? 2;

  // 1. 入参校验 + 读当前字节（权威原文，非图谱快照）
  if (input.files.length === 0) return { ok: false, error: 'INVALID_INPUT', detail: 'files 为空', attempts: 0 };
  if (input.files.length > MAX_TARGET_FILES) {
    return { ok: false, error: 'INVALID_INPUT', detail: `目标文件数 ${input.files.length} 超上限 ${MAX_TARGET_FILES}`, attempts: 0 };
  }

  const originals = new Map<string, { content: string; sha: string }>();
  for (const rel of input.files) {
    const safe = checkRepoRelativePath(repoPath, rel);
    if (!safe.ok || !safe.absPath || !safe.relPath) {
      return { ok: false, error: 'INVALID_INPUT', detail: `路径不安全：${rel}（${safe.reason ?? ''}）`, attempts: 0 };
    }
    let buf: Buffer;
    try {
      const stat = fs.statSync(safe.absPath);
      if (!stat.isFile()) return { ok: false, error: 'INVALID_INPUT', detail: `不是文件：${rel}`, attempts: 0 };
      buf = fs.readFileSync(safe.absPath);
    } catch {
      return { ok: false, error: 'INVALID_INPUT', detail: `文件不存在或不可读：${rel}`, attempts: 0 };
    }
    originals.set(safe.relPath, { content: buf.toString('utf8'), sha: sha256OfBytes(buf) });
  }
  const relFiles = [...originals.keys()];

  // 2. 有界重试
  let feedback: string | undefined;
  let lastDetail = '';
  let attempt = 0;
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildProposeMessages(
      input.question,
      relFiles.map((f) => ({ path: f, content: originals.get(f)!.content })),
      feedback,
    );
    const raw = await deps.llm(messages, deps.signal);
    if (raw === null) return { ok: false, error: 'LLM_UNAVAILABLE', detail: 'LLM 不可用或被中止', attempts: attempt };

    const blocks = parseEditBlocks(raw);
    if (blocks.length === 0) {
      lastDetail = '未产出任何 SEARCH/REPLACE 块';
      feedback = `${lastDetail}。请严格用 <<<<<<< SEARCH … ======= … >>>>>>> REPLACE 格式输出编辑块。`;
      continue;
    }

    // 越界文件（编辑指向未声明文件）——先挡，给可反馈原因
    const defaultFile = relFiles.length === 1 ? relFiles[0] : undefined;
    const byFile = groupEditsByFile(blocks, defaultFile);
    const stray = [...byFile.keys()].find((f) => !originals.has(normalizeRel(f)));
    if (stray) {
      lastDetail = `编辑指向未声明文件：${stray}`;
      feedback = `${lastDetail}。只允许修改这些文件：${relFiles.join(', ')}`;
      continue;
    }

    // 逐文件应用 → 新内容 → synth diff
    let applyError: string | undefined;
    const diffs: string[] = [];
    const changedFiles: Array<{ file: string; sha: string }> = [];
    for (const [file, edits] of byFile) {
      const rel = normalizeRel(file);
      const orig = originals.get(rel)!;
      const applied = applyEditsToFile(orig.content, edits);
      if (!applied.ok || applied.content === undefined) {
        applyError = `${rel}: ${applied.error}`;
        break;
      }
      const diff = synthUnifiedDiff(orig.content, applied.content, rel);
      if (diff) {
        diffs.push(diff);
        changedFiles.push({ file: rel, sha: orig.sha });
      }
    }
    if (applyError) {
      lastDetail = applyError;
      feedback = `编辑无法定位：${applyError}。SEARCH 必须与当前文件逐字一致（含缩进），并带足够上下文唯一匹配。`;
      continue;
    }
    if (diffs.length === 0) {
      return { ok: false, error: 'NO_CHANGE', detail: '生成的编辑未改变任何文件', attempts: attempt };
    }

    // 3. G0 确定性 gate
    const proposal: PatchProposal = {
      proposalId: deps.newId(),
      repoName: input.repoName,
      question: input.question,
      unifiedDiff: diffs.join(''),
      files: changedFiles.map((cf) => ({
        file: cf.file,
        baselineSha256: cf.sha,
        reason: `为满足诉求「${input.question.slice(0, 60)}」修改 ${cf.file}`,
        evidenceRefs: input.evidenceRefs,
      })),
      verifyCommands: [],
      validatedAt: '',
    };

    const validation = await validateProposal(proposal, repoPath);
    if (validation.ok) {
      proposal.validatedAt = deps.now();
      return { ok: true, proposal, attempts: attempt };
    }
    lastDetail = `${validation.reason}: ${validation.detail ?? ''}`;
    feedback = `上一版补丁校验失败（${validation.reason}）：${(validation.detail ?? '').slice(0, 500)}。请修正后重新输出编辑块。`;
  }

  return { ok: false, error: 'PATCH_NOT_APPLICABLE', detail: lastDetail, attempts: maxAttempts };
}
