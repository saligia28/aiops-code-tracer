/**
 * apply / rollback 确定性核心（P2-G 第二刀）。临时 SQLite 库 + 临时 git 仓库，全程离线：
 * 真落盘（file 实际被写）/ 回滚逐字节还原 / 基线不符拒绝落盘（审计佐证）/ 重复 apply 拒绝 /
 * 回滚漂移检测（落盘后被人动过不覆盖）/ NOT_FOUND。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 关键：import store/apply 之前把 DB 指到临时库，绝不碰真实 app.db
const TMP_DB = path.join(os.tmpdir(), `aiops-patch-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

type Store = typeof import('../../src/db/patchStore.js');
type ApplyMod = typeof import('../../src/services/patch/applyPatch.js');
type Baseline = typeof import('../../src/services/patch/baseline.js');
let store: Store;
let apply: ApplyMod;
let baseline: Baseline;

beforeAll(async () => {
  store = await import('../../src/db/patchStore.js');
  apply = await import('../../src/services/patch/applyPatch.js');
  baseline = await import('../../src/services/patch/baseline.js');
});

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

const REL = 'src/api/orderVoid.ts';
const NEW_LINE = "  if (!id) throw new Error('missing id')";
const ORIGINAL = [
  'export async function voidOrder(id) {',
  '  if (!id) return',
  "  return request.post('/order/void', { id })",
  '}',
  '',
].join('\n');
const APPLIED = [
  'export async function voidOrder(id) {',
  NEW_LINE,
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
  '+' + NEW_LINE,
  "   return request.post('/order/void', { id })",
  ' }',
  '',
].join('\n');

let repo: string;

function insertGoodProposal(): string {
  const id = crypto.randomUUID();
  store.insertProposal({
    id,
    repoName: 'fixture',
    question: '空 id 应抛错',
    unifiedDiff: GOOD_DIFF,
    files: [{ file: REL, baselineSha256: baseline.sha256OfBytes(Buffer.from(ORIGINAL)), reason: 'r' }],
    verifyCommands: ['pnpm -C apps/api test'],
    validatedAt: 'T',
  });
  return id;
}

const readTarget = (): string => fs.readFileSync(path.join(repo, REL), 'utf8');

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, REL), ORIGINAL);
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('applyPatch', () => {
  it('成功：真落盘（文件被实际写成新内容）+ 状态 applied + 存快照 + 审计', async () => {
    const id = insertGoodProposal();
    const r = await apply.applyPatch(id, repo);
    expect(r.ok).toBe(true);
    expect(readTarget()).toBe(APPLIED); // 硬证据：文件真被写
    const p = store.getProposal(id)!;
    expect(p.status).toBe('applied');
    expect(p.snapshot![REL].originalBase64).toBe(Buffer.from(ORIGINAL).toString('base64'));
    expect(store.getAudit(id).some((a) => a.action === 'apply' && a.result === 'ok')).toBe(true);
  });

  it('基线不符：文件已变则拒绝落盘（BASELINE_MISMATCH），文件不动 + 审计佐证', async () => {
    const id = insertGoodProposal();
    const drifted = ORIGINAL + '// 生成后被改\n';
    fs.writeFileSync(path.join(repo, REL), drifted);
    const r = await apply.applyPatch(id, repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('BASELINE_MISMATCH');
    expect(readTarget()).toBe(drifted); // 未落盘，文件保持
    expect(store.getProposal(id)!.status).toBe('proposed');
    expect(store.getAudit(id).some((a) => a.action === 'apply_rejected')).toBe(true);
  });

  it('重复 apply：第二次 BAD_STATUS', async () => {
    const id = insertGoodProposal();
    expect((await apply.applyPatch(id, repo)).ok).toBe(true);
    const r = await apply.applyPatch(id, repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('BAD_STATUS');
  });

  it('NOT_FOUND：未知提案 id', async () => {
    const r = await apply.applyPatch('does-not-exist', repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NOT_FOUND');
  });
});

describe('rollbackPatch', () => {
  it('apply → rollback：逐字节还原原始内容 + 状态 rolled_back', async () => {
    const id = insertGoodProposal();
    await apply.applyPatch(id, repo);
    expect(readTarget()).toBe(APPLIED);

    const r = await apply.rollbackPatch(id, repo);
    expect(r.ok).toBe(true);
    expect(readTarget()).toBe(ORIGINAL); // 逐字节还原
    expect(store.getProposal(id)!.status).toBe('rolled_back');
    expect(store.getAudit(id).some((a) => a.action === 'rollback' && a.result === 'ok')).toBe(true);
  });

  it('漂移检测：落盘后文件被人动过则拒绝回滚（DRIFT_SINCE_APPLY），不覆盖', async () => {
    const id = insertGoodProposal();
    await apply.applyPatch(id, repo);
    const handEdit = APPLIED + '// 落盘后手改\n';
    fs.writeFileSync(path.join(repo, REL), handEdit);

    const r = await apply.rollbackPatch(id, repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('DRIFT_SINCE_APPLY');
    expect(readTarget()).toBe(handEdit); // 未被覆盖
  });

  it('未落盘的提案不可回滚：BAD_STATUS', async () => {
    const id = insertGoodProposal();
    const r = await apply.rollbackPatch(id, repo);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('BAD_STATUS');
  });
});
