import { spawn } from 'node:child_process';

// ============================================================
// git apply（校验 gate + 真·落盘）
// LLM 生成 hunk 最常见的失败是行号漂移 / 上下文不匹配 / 缩进错——一个打不上的 diff 对
// 下游 apply 阶段毫无价值。这里用 stdin 传 diff，全程不落任何临时 patch 文件：
// 校验（--check）阶段"未审批绝不写盘"从此成立（连临时文件都不产生）。
// gitApply（无 --check）是第二刀真正落盘的写操作，仅经审批门调用。
// ============================================================

export interface GitApplyResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

/** 兼容旧名。 */
export type GitApplyCheckResult = GitApplyResult;

const STDERR_LIMIT = 2000;

function runGitApply(
  repoPath: string,
  unifiedDiff: string,
  extraArgs: string[],
  timeoutMs: number,
): Promise<GitApplyResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', ...extraArgs, '--whitespace=nowarn', '-'], { cwd: repoPath });

    let stderr = '';
    let settled = false;
    const done = (r: GitApplyResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, code: null, stderr: `git apply 超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, code: null, stderr: `git 无法执行：${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, stderr: stderr.slice(0, STDERR_LIMIT).trim() });
    });

    // stdin EPIPE：子进程可能在写完前已退出，close 处理器会兜结果
    child.stdin.on('error', () => { /* noop */ });
    // diff 必须以换行结尾，否则末 hunk 可能被 git 判为不完整
    child.stdin.end(unifiedDiff.endsWith('\n') ? unifiedDiff : unifiedDiff + '\n');
  });
}

/**
 * `git apply --check -`：只校验能否干净打上，不写盘。硬验收 gate。
 * 不传任何 --3way，严格要求上下文匹配。
 */
export function gitApplyCheck(
  repoPath: string,
  unifiedDiff: string,
  opts: { timeoutMs?: number } = {},
): Promise<GitApplyResult> {
  return runGitApply(repoPath, unifiedDiff, ['--check'], opts.timeoutMs ?? 10_000);
}

/**
 * `git apply -`：真正落盘（写工作树）。仅经审批门（第二刀）在重校验通过后调用。
 * git apply 是全或无：全部 hunk 预检通过才落盘，任一失败则不改任何文件（配合调用方的
 * apply 前 --check + 基线锚定，落盘失败面已很小）。
 */
export function gitApply(
  repoPath: string,
  unifiedDiff: string,
  opts: { timeoutMs?: number } = {},
): Promise<GitApplyResult> {
  return runGitApply(repoPath, unifiedDiff, [], opts.timeoutMs ?? 10_000);
}
