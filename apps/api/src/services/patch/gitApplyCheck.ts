import { spawn } from 'node:child_process';

// ============================================================
// git apply --check 硬验收 gate
// LLM 生成 hunk 最常见的失败是行号漂移 / 上下文不匹配 / 缩进错——一个打不上的 diff 对
// 下游 apply 阶段毫无价值。这里用 stdin 传 diff，全程不落任何临时 patch 文件：
// "未审批绝不写盘"从这一层就成立（连临时文件都不产生）。只校验、不应用。
// ============================================================

export interface GitApplyCheckResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

const STDERR_LIMIT = 2000;

export function gitApplyCheck(
  repoPath: string,
  unifiedDiff: string,
  opts: { timeoutMs?: number } = {},
): Promise<GitApplyCheckResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    // --whitespace=nowarn：避免空白告警污染 stderr；不传任何 --3way，严格要求上下文匹配
    const child = spawn('git', ['apply', '--check', '--whitespace=nowarn', '-'], {
      cwd: repoPath,
    });

    let stderr = '';
    let settled = false;
    const done = (r: GitApplyCheckResult): void => {
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
