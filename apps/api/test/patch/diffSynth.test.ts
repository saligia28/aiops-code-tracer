/**
 * 内存 unified diff 合成（P2-G1 方案 B）。核心验证是"往返 git"：synth(old→new) 产出的
 * diff 用真实 `git apply` 打到 old 上，结果必须逐字节等于 new——直接证明可应用性，
 * 而非靠肉眼看格式。覆盖首/中/末行改动、纯增/删、多 hunk、相邻合并、无末尾换行。
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthUnifiedDiff } from '../../src/services/patch/diffSynth.js';

/** 把 synth 出的 diff 用真实 git apply 打到 oldText，返回结果内容。 */
function applyThroughGit(oldText: string, diff: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffsynth-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), oldText);
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dir, input: diff });
    return fs.readFileSync(path.join(dir, 'f.txt'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 往返：synth → git apply → 应与 newText 一致。 */
function roundTrip(oldText: string, newText: string): string {
  const diff = synthUnifiedDiff(oldText, newText, 'f.txt');
  return applyThroughGit(oldText, diff);
}

const L = (...xs: string[]): string => xs.join('\n') + '\n';

describe('synthUnifiedDiff · 往返 git apply', () => {
  it('无改动 → 空 diff', () => {
    expect(synthUnifiedDiff('a\nb\n', 'a\nb\n', 'f.txt')).toBe('');
  });

  it('中间行改动', () => {
    const oldT = L('l1', 'l2', 'l3', 'l4', 'l5');
    const newT = L('l1', 'l2', 'L3', 'l4', 'l5');
    const diff = synthUnifiedDiff(oldT, newT, 'f.txt');
    expect(diff).toContain('@@ -1,5 +1,5 @@'); // 锁定 hunk 头格式
    expect(applyThroughGit(oldT, diff)).toBe(newT);
  });

  it('首行改动', () => {
    expect(roundTrip(L('l1', 'l2', 'l3'), L('L1', 'l2', 'l3'))).toBe(L('L1', 'l2', 'l3'));
  });

  it('末行改动', () => {
    expect(roundTrip(L('l1', 'l2', 'l3'), L('l1', 'l2', 'L3'))).toBe(L('l1', 'l2', 'L3'));
  });

  it('中间纯插入', () => {
    expect(roundTrip(L('l1', 'l2', 'l3'), L('l1', 'l2', 'lx', 'l3'))).toBe(L('l1', 'l2', 'lx', 'l3'));
  });

  it('中间纯删除', () => {
    expect(roundTrip(L('l1', 'l2', 'l3', 'l4'), L('l1', 'l2', 'l4'))).toBe(L('l1', 'l2', 'l4'));
  });

  it('开头插入', () => {
    expect(roundTrip(L('l1', 'l2'), L('l0', 'l1', 'l2'))).toBe(L('l0', 'l1', 'l2'));
  });

  it('末尾删除', () => {
    expect(roundTrip(L('l1', 'l2', 'l3'), L('l1', 'l2'))).toBe(L('l1', 'l2'));
  });

  it('两处相隔较远的改动 → 两个 hunk', () => {
    const oldT = L('a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12');
    const newT = L('a1', 'A2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'A11', 'a12');
    const diff = synthUnifiedDiff(oldT, newT, 'f.txt');
    expect((diff.match(/^@@ /gm) || []).length).toBe(2);
    expect(applyThroughGit(oldT, diff)).toBe(newT);
  });

  it('相邻改动 → 合并为一个 hunk', () => {
    const oldT = L('a1', 'a2', 'a3', 'a4', 'a5');
    const newT = L('a1', 'A2', 'A3', 'a4', 'a5');
    const diff = synthUnifiedDiff(oldT, newT, 'f.txt');
    expect((diff.match(/^@@ /gm) || []).length).toBe(1);
    expect(applyThroughGit(oldT, diff)).toBe(newT);
  });

  it('无末尾换行文件改末行（\\ No newline 标记）', () => {
    const oldT = 'a\nb\nc'; // 无末尾换行
    const newT = 'a\nb\nC';
    const diff = synthUnifiedDiff(oldT, newT, 'f.txt');
    expect(diff).toContain('\\ No newline at end of file');
    expect(applyThroughGit(oldT, diff)).toBe(newT);
  });

  it('真实代码片段（orderVoid 风格）往返一致', () => {
    const oldT = L(
      'export async function voidOrder(id) {',
      '  if (!id) return',
      "  return request.post('/order/void', { id })",
      '}',
    );
    const newT = L(
      'export async function voidOrder(id) {',
      "  if (!id) throw new Error('missing id')",
      "  return request.post('/order/void', { id })",
      '}',
    );
    expect(roundTrip(oldT, newT)).toBe(newT);
  });
});
