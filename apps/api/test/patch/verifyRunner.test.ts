/**
 * 沙箱验证运行器（P2-G 第三刀）。用 stub 命令确定性验证：退出码判 pass/fail、
 * 输出捕获、cwd 正确、超时终止、未配置命令则不跑。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runVerify } from '../../src/services/patch/verifyRunner.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'CWD_MARKER_123');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('退出码 0 → passed', async () => {
    const r = await runVerify(dir, { command: 'exit 0' });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('非零退出码 → 未通过', async () => {
    const r = await runVerify(dir, { command: 'exit 3' });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(3);
  });

  it('捕获 stdout/stderr 输出', async () => {
    const r = await runVerify(dir, { command: 'echo out; echo err 1>&2' });
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('在 repoPath 下执行（cwd 正确）', async () => {
    const r = await runVerify(dir, { command: 'cat marker.txt' });
    expect(r.passed).toBe(true);
    expect(r.output).toContain('CWD_MARKER_123');
  });

  it('超时被终止 → timedOut + 未通过', async () => {
    const r = await runVerify(dir, { command: 'sleep 5', timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.output).toContain('超时');
  });

  it('未配置命令 → ran=false（不跑）', async () => {
    const r = await runVerify(dir, { command: '   ' });
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
  });
});
