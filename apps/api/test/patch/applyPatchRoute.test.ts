/**
 * /api/apply-patch、/api/rollback 路由（P2-G 第二刀 · 审批门）。临时库 + 临时 git 仓库。
 * 三重闸的路由侧：ALLOW_APPLY 权限门（默认关→403）、confirm 二次确认门、以及完整 E2E
 * （插提案 → 审批落盘 → 回滚）。基线重校验等落盘逻辑由 applyPatch.test.ts 深测。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TMP_DB = path.join(os.tmpdir(), `aiops-apply-route-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

type Store = typeof import('../../src/db/patchStore.js');
type Ctx = typeof import('../../src/context.js');
type Baseline = typeof import('../../src/services/patch/baseline.js');
let store: Store;
let ctx: Ctx;
let baseline: Baseline;
let app: FastifyInstance;
let originalRepoPath: string;

const REL = 'src/api/orderVoid.ts';
const NEW_LINE = "  if (!id) throw new Error('missing id')";
const ORIGINAL = ['export async function voidOrder(id) {', '  if (!id) return', "  return request.post('/order/void', { id })", '}', ''].join('\n');
const APPLIED = ['export async function voidOrder(id) {', NEW_LINE, "  return request.post('/order/void', { id })", '}', ''].join('\n');
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

beforeAll(async () => {
  store = await import('../../src/db/patchStore.js');
  ctx = await import('../../src/context.js');
  baseline = await import('../../src/services/patch/baseline.js');
  originalRepoPath = ctx.currentRepoPath;
  const { registerProposePatch } = await import('../../src/routes/proposePatch.js');
  app = Fastify({ logger: false });
  registerProposePatch(app);
  await app.ready();
});

afterAll(async () => {
  ctx.setCurrentRepoPath(originalRepoPath);
  await app?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-route-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, REL), ORIGINAL);
  ctx.setCurrentRepoPath(repo);
});
afterEach(() => {
  delete process.env.ALLOW_APPLY;
  delete process.env.VERIFY_COMMAND;
  fs.rmSync(repo, { recursive: true, force: true });
});

function insertGoodProposal(): string {
  const id = crypto.randomUUID();
  store.insertProposal({
    id, repoName: 'fixture', question: 'q', unifiedDiff: GOOD_DIFF,
    files: [{ file: REL, baselineSha256: baseline.sha256OfBytes(Buffer.from(ORIGINAL)), reason: 'r' }],
    verifyCommands: [], validatedAt: 'T',
  });
  return id;
}

/** 插一个已 apply 的提案（verify 要求 status=applied）。 */
function insertAppliedProposal(): string {
  const id = insertGoodProposal();
  store.markApplied(id, {}, Date.now());
  return id;
}

const apply = (payload: unknown) => app.inject({ method: 'POST', url: '/api/apply-patch', payload });
const rollback = (payload: unknown) => app.inject({ method: 'POST', url: '/api/rollback', payload });
const verify = (payload: unknown) => app.inject({ method: 'POST', url: '/api/verify', payload });

describe('/api/apply-patch · 审批门', () => {
  it('ALLOW_APPLY 未开 → 403 APPLY_DISABLED（默认无写盘可能）', async () => {
    const res = await apply({ proposalId: insertGoodProposal(), confirm: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('APPLY_DISABLED');
  });

  it('缺 proposalId → 400', async () => {
    process.env.ALLOW_APPLY = 'true';
    expect((await apply({ confirm: true })).statusCode).toBe(400);
  });

  it('缺 confirm → 400 CONFIRM_REQUIRED（人工二次确认门）', async () => {
    process.env.ALLOW_APPLY = 'true';
    const res = await apply({ proposalId: insertGoodProposal() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('CONFIRM_REQUIRED');
  });

  it('未知 proposalId → 404', async () => {
    process.env.ALLOW_APPLY = 'true';
    const res = await apply({ proposalId: 'nope', confirm: true });
    expect(res.statusCode).toBe(404);
  });

  it('E2E：审批落盘 → 文件被写 → 回滚还原', async () => {
    process.env.ALLOW_APPLY = 'true';
    const id = insertGoodProposal();

    const applyRes = await apply({ proposalId: id, confirm: true });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json().ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, REL), 'utf8')).toBe(APPLIED); // 真落盘

    const rbRes = await rollback({ proposalId: id });
    expect(rbRes.statusCode).toBe(200);
    expect(rbRes.json().ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, REL), 'utf8')).toBe(ORIGINAL); // 还原
  });
});

describe('/api/rollback · 权限门', () => {
  it('ALLOW_APPLY 未开 → 403', async () => {
    const res = await rollback({ proposalId: insertGoodProposal() });
    expect(res.statusCode).toBe(403);
  });
});

describe('/api/verify · 沙箱验证（就地后验）', () => {
  it('ALLOW_APPLY 未开 → 403', async () => {
    const res = await verify({ proposalId: insertAppliedProposal() });
    expect(res.statusCode).toBe(403);
  });

  it('缺 proposalId → 400', async () => {
    process.env.ALLOW_APPLY = 'true';
    expect((await verify({})).statusCode).toBe(400);
  });

  it('未知 proposalId → 404', async () => {
    process.env.ALLOW_APPLY = 'true';
    process.env.VERIFY_COMMAND = 'exit 0';
    expect((await verify({ proposalId: 'nope' })).statusCode).toBe(404);
  });

  it('提案未 apply → 409（需先 apply 再验证）', async () => {
    process.env.ALLOW_APPLY = 'true';
    process.env.VERIFY_COMMAND = 'exit 0';
    const res = await verify({ proposalId: insertGoodProposal() }); // proposed 态
    expect(res.statusCode).toBe(409);
  });

  it('已 apply 但未配置 VERIFY_COMMAND → 200 {ran:false}', async () => {
    process.env.ALLOW_APPLY = 'true';
    const res = await verify({ proposalId: insertAppliedProposal() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ran).toBe(false);
    expect(res.json().reason).toBe('VERIFY_NOT_CONFIGURED');
  });

  it('已 apply + 命令通过 → 200 passed:true', async () => {
    process.env.ALLOW_APPLY = 'true';
    process.env.VERIFY_COMMAND = 'exit 0';
    const res = await verify({ proposalId: insertAppliedProposal() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ran).toBe(true);
    expect(res.json().passed).toBe(true);
  });

  it('已 apply + 命令失败 → 200 passed:false（测试不过不是传输错误）', async () => {
    process.env.ALLOW_APPLY = 'true';
    process.env.VERIFY_COMMAND = 'echo boom 1>&2; exit 1';
    const res = await verify({ proposalId: insertAppliedProposal() });
    expect(res.statusCode).toBe(200);
    expect(res.json().passed).toBe(false);
    expect(res.json().output).toContain('boom');
  });
});
