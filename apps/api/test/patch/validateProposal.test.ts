/**
 * 确定性校验器端到端（P2-G0）：临时 git 仓库 + orderVoid 风格目标文件。
 * 覆盖成功路径、基线不符、git 打不上、越权操作、越界文件、路径不安全、文件缺失；
 * 并断言全过程仓库文件字节完全不变（"未审批绝不写盘"的硬证据）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProposal } from '../../src/services/patch/validateProposal.js';
import { sha256OfFile } from '../../src/services/patch/baseline.js';
import type { PatchProposal } from '../../src/services/patch/types.js';

let repo: string;
const REL = 'src/api/orderVoid.ts';

const ORIGINAL = [
  'export async function voidOrder(id) {',
  '  if (!id) return',
  "  return request.post('/order/void', { id })",
  '}',
  '',
].join('\n');

const GOOD_DIFF = [
  'diff --git a/src/api/orderVoid.ts b/src/api/orderVoid.ts',
  '--- a/src/api/orderVoid.ts',
  '+++ b/src/api/orderVoid.ts',
  '@@ -1,4 +1,4 @@',
  ' export async function voidOrder(id) {',
  '-  if (!id) return',
  "+  if (!id) throw new Error('missing id')",
  "   return request.post('/order/void', { id })",
  ' }',
  '',
].join('\n');

function baseProposal(overrides: Partial<PatchProposal> = {}): PatchProposal {
  const sha = sha256OfFile(path.join(repo, REL))!;
  return {
    proposalId: 'p1',
    repoName: 'fixture',
    question: '订单作废缺 id 时应报错而非静默返回',
    unifiedDiff: GOOD_DIFF,
    files: [{ file: REL, baselineSha256: sha, reason: '空 id 改为抛错' }],
    verifyCommands: ['pnpm -C apps/api test'],
    validatedAt: '',
    ...overrides,
  };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-vp-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, REL), ORIGINAL);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('validateProposal', () => {
  it('成功路径：diff 合法、基线匹配、git apply --check 通过', async () => {
    const before = fs.readFileSync(path.join(repo, REL));
    const r = await validateProposal(baseProposal(), repo);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.baselines[0].sha256).toBe(sha256OfFile(path.join(repo, REL)));
    // 硬证据：全过程仓库文件字节不变
    const after = fs.readFileSync(path.join(repo, REL));
    expect(before.equals(after)).toBe(true);
  });

  it('基线不符（提案基于旧内容）→ BASELINE_MISMATCH', async () => {
    const r = await validateProposal(baseProposal({ files: [{ file: REL, baselineSha256: 'deadbeef', reason: '' }] }), repo);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BASELINE_MISMATCH');
  });

  it('diff 上下文漂移（打不上）→ GIT_APPLY_FAILED', async () => {
    const drifted = GOOD_DIFF.replace('  if (!id) return', '  if (!id) STALE');
    const r = await validateProposal(baseProposal({ unifiedDiff: drifted }), repo);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('GIT_APPLY_FAILED');
    expect(r.detail?.length).toBeGreaterThan(0);
  });

  it('新增文件操作 → DISALLOWED_OP', async () => {
    const addDiff = [
      'diff --git a/src/api/new.ts b/src/api/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/api/new.ts',
      '@@ -0,0 +1,1 @@',
      '+x',
      '',
    ].join('\n');
    const r = await validateProposal(baseProposal({ unifiedDiff: addDiff, files: [{ file: 'src/api/new.ts', baselineSha256: 'x', reason: '' }] }), repo);
    expect(r.reason).toBe('DISALLOWED_OP');
  });

  it('diff 触碰未声明文件 → UNLISTED_FILE', async () => {
    const r = await validateProposal(baseProposal({ files: [{ file: 'src/api/priceCheck.ts', baselineSha256: 'x', reason: '' }] }), repo);
    expect(r.reason).toBe('UNLISTED_FILE');
  });

  it('声明越界路径（..）→ PATH_UNSAFE', async () => {
    const evilDiff = [
      'diff --git a/../evil.ts b/../evil.ts',
      '--- a/../evil.ts',
      '+++ b/../evil.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    const r = await validateProposal(baseProposal({ unifiedDiff: evilDiff, files: [{ file: '../evil.ts', baselineSha256: 'x', reason: '' }] }), repo);
    expect(r.reason).toBe('PATH_UNSAFE');
  });

  it('目标文件不存在 → FILE_MISSING', async () => {
    const ghostDiff = [
      'diff --git a/src/api/ghost.ts b/src/api/ghost.ts',
      '--- a/src/api/ghost.ts',
      '+++ b/src/api/ghost.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    const r = await validateProposal(baseProposal({ unifiedDiff: ghostDiff, files: [{ file: 'src/api/ghost.ts', baselineSha256: 'x', reason: '' }] }), repo);
    expect(r.reason).toBe('FILE_MISSING');
  });
});
