import { spawn } from 'node:child_process';

// ============================================================
// 沙箱验证运行器（P2-G 第三刀 · 就地后验）
// apply 到主树后，在真实环境跑一条【服务端配置】的验证命令（lint/test），退出码判 pass/fail。
// 安全边界：命令只来自 env（可信管理员配置），绝不用 LLM/提案里的命令——那才有注入风险；
// 这条命令是管理员自己设的，等价于"跑 npm test"，用 sh -c 执行是可接受的。
// ============================================================

export interface VerifyResult {
  /** 是否真的跑了（未配置命令则 false）。 */
  ran: boolean;
  /** 是否通过（未超时且退出码 0）。 */
  passed: boolean;
  exitCode: number | null;
  /** 截断的 stdout+stderr（供人看）。 */
  output: string;
  /** 实际执行的命令（回显便于核对）。 */
  command: string;
  timedOut: boolean;
}

const OUTPUT_LIMIT = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** 验证命令来自 env `VERIFY_COMMAND`（可信）；空=未配置。 */
export function getVerifyCommand(): string {
  return (process.env.VERIFY_COMMAND ?? '').trim();
}

export function runVerify(
  repoPath: string,
  opts: { timeoutMs?: number; command?: string } = {},
): Promise<VerifyResult> {
  const command = (opts.command ?? getVerifyCommand()).trim();
  if (!command) {
    return Promise.resolve({ ran: false, passed: false, exitCode: null, output: '', command: '', timedOut: false });
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: repoPath });
    let output = '';
    let timedOut = false;
    let settled = false;
    const append = (d: Buffer): void => {
      if (output.length < OUTPUT_LIMIT) output += d.toString();
    };
    const done = (r: VerifyResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ran: true, passed: false, exitCode: null, output: `无法执行 verify 命令：${err.message}`, command, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        ran: true,
        passed: !timedOut && code === 0,
        exitCode: code,
        output: (timedOut ? `[超时 ${timeoutMs}ms，已终止]\n` : '') + output.slice(0, OUTPUT_LIMIT).trim(),
        command,
        timedOut,
      });
    });
  });
}
