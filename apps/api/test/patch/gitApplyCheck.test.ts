/**
 * git apply --check 硬 gate（P2-G0）：真实 git，临时仓库，全程 stdin 不落盘。
 * 干净 diff 通过；上下文漂移的 diff 被拒并带 stderr。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitApplyCheck } from '../../src/services/patch/gitApplyCheck.js';

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-gac-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\nline3\n');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const cleanDiff = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-line2',
  '+line2-modified',
  ' line3',
  '',
].join('\n');

const driftedDiff = [
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-lineX', // 上下文与真实文件不符
  '+lineY',
  ' line3',
  '',
].join('\n');

describe('gitApplyCheck', () => {
  it('干净 diff → ok', async () => {
    const r = await gitApplyCheck(repo, cleanDiff);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it('上下文漂移 → 拒绝并带 stderr', async () => {
    const r = await gitApplyCheck(repo, driftedDiff);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('目标文件不存在 → 拒绝', async () => {
    const diff = ['diff --git a/ghost.txt b/ghost.txt', '--- a/ghost.txt', '+++ b/ghost.txt', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n');
    const r = await gitApplyCheck(repo, diff);
    expect(r.ok).toBe(false);
  });

  it('校验后仓库文件未被改（只 --check 不 apply）', async () => {
    const before = fs.readFileSync(path.join(repo, 'a.txt'));
    await gitApplyCheck(repo, cleanDiff);
    const after = fs.readFileSync(path.join(repo, 'a.txt'));
    expect(before.equals(after)).toBe(true);
  });
});
