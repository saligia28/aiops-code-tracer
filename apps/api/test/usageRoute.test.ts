/**
 * 成本查询端点（设计文档 §12.3）。
 *
 * 重点是**跨项目一律 404**：区分"不存在"和"无权访问"就等于提供了枚举别人 turn 的接口。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-usage-route-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

let app: FastifyInstance;
let createUsageTurn: typeof import('../src/db/usageStore.ts').createUsageTurn;
let recordUsageEvent: typeof import('../src/db/usageStore.ts').recordUsageEvent;
let activeProjectId: string;

beforeAll(async () => {
  const store = await import('../src/db/usageStore.ts');
  createUsageTurn = store.createUsageTurn;
  recordUsageEvent = store.recordUsageEvent;
  const ctx = await import('../src/context.ts');
  activeProjectId = ctx.resolveActiveProjectId();

  const { registerUsage } = await import('../src/routes/usage.js');
  app = Fastify({ logger: false });
  registerUsage(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

function seedTurn(projectId: string): string {
  const turnId = createUsageTurn({ projectId, pipeline: 'ask', source: 'web' });
  recordUsageEvent({
    turnId,
    stage: 'ask.answer_complex',
    stageCallIndex: 0,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    canonicalModel: 'deepseek-v4-flash',
    transportStatus: 'success',
    usageSource: 'provider',
    deliveryMode: 'non_stream',
    validationWarnings: [],
    tokens: { promptTokens: 10, cacheHitTokens: 10, cacheMissTokens: 0, completionTokens: 5, totalTokens: 15 },
    totalCostNanoCny: 10_200,
    latencyMs: 42,
  });
  return turnId;
}

describe('GET /api/usage/turns/:turnId', () => {
  it('本项目的 turn：返回汇总 + 明细，且明细稳定排序', async () => {
    const turnId = seedTurn(activeProjectId);
    const res = await app.inject({ method: 'GET', url: `/api/usage/turns/${turnId}` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { turnId: string; knownCostNanoCny: number }; events: unknown[] };
    expect(body.summary.turnId).toBe(turnId);
    expect(body.summary.knownCostNanoCny).toBe(10_200);
    expect(body.events).toHaveLength(1);
  });

  it('不存在的 turn → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/usage/turns/no-such-turn' });
    expect(res.statusCode).toBe(404);
  });

  it('跨项目的 turn → 同样 404（不泄露"存在但无权"这个信息）', async () => {
    const foreign = seedTurn('some-other-project');
    const res = await app.inject({ method: 'GET', url: `/api/usage/turns/${foreign}` });
    expect(res.statusCode).toBe(404);
    // 两种 404 的响应体必须一致，否则仍可用响应差异区分
    const missing = await app.inject({ method: 'GET', url: '/api/usage/turns/nope' });
    expect(res.json()).toEqual(missing.json());
  });

  it('event 只含受控字段白名单：prompt/回答/工具结果/密钥都进不来', async () => {
    const turnId = seedTurn(activeProjectId);
    const res = await app.inject({ method: 'GET', url: `/api/usage/turns/${turnId}` });
    const body = res.json() as { events: Array<Record<string, unknown>> };

    // 用白名单而不是黑名单关键词：黑名单会被 stage 名里的 "answer" 之类误伤，
    // 更重要的是白名单能挡住**将来新增**的敏感字段（新字段不在名单里就会红）
    const ALLOWED = new Set([
      'id', 'turnId', 'stage', 'stageCallIndex', 'provider', 'model', 'canonicalModel',
      'transportStatus', 'usageSource', 'deliveryMode', 'validationWarnings', 'tokens',
      'pricing', 'cacheHitCostNanoCny', 'cacheMissCostNanoCny', 'outputCostNanoCny',
      'totalCostNanoCny', 'latencyMs', 'errorKind', 'createdAt',
    ]);
    for (const event of body.events) {
      for (const key of Object.keys(event)) {
        expect(ALLOWED.has(key), `event 出现未受控字段: ${key}`).toBe(true);
      }
    }
  });
});
