/**
 * /api/propose-patch 路由守卫（P2-G1）。只覆盖不需 LLM 的确定性路径：
 * 结构性坏请求 → 400；未加载仓库 → 200 {ok:false, reason:'NO_REPO'}。
 * 成功/重试/放弃等 LLM 路径由 proposePatch.test.ts（mock LLM）深测。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

let app: FastifyInstance;
let originalRepoPath: string;

beforeAll(async () => {
  const ctx = await import('../../src/context.js');
  originalRepoPath = ctx.currentRepoPath;
  const { registerProposePatch } = await import('../../src/routes/proposePatch.js');
  app = Fastify({ logger: false });
  registerProposePatch(app);
  await app.ready();
});

afterAll(async () => {
  const { setCurrentRepoPath } = await import('../../src/context.js');
  setCurrentRepoPath(originalRepoPath);
  await app?.close();
});

const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/propose-patch', payload });

describe('/api/propose-patch · 路由守卫', () => {
  it('缺 question → 400 INVALID_PARAMS', async () => {
    const res = await post({ files: ['a.ts'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_PARAMS');
  });

  it('files 非数组/空 → 400 INVALID_PARAMS', async () => {
    expect((await post({ question: '改点东西', files: [] })).statusCode).toBe(400);
    expect((await post({ question: '改点东西' })).statusCode).toBe(400);
    expect((await post({ question: '改点东西', files: 'a.ts' })).statusCode).toBe(400);
  });

  it('未加载仓库 → 200 {ok:false, reason:NO_REPO}', async () => {
    const { setCurrentRepoPath } = await import('../../src/context.js');
    setCurrentRepoPath('');
    const res = await post({ question: '改点东西', files: ['a.ts'] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('NO_REPO');
  });
});
