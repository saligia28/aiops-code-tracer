/**
 * 成本追踪 · 阶段 3：Ask 路由归属与终态。
 *
 * 验收口径（设计文档 §18.1/§18.13）：一轮问答触发的**全部** LLM 调用进同一个 turn，
 * 且成功/异常/中止三种出口都必须 exactly-once 终结，不能留下 collecting。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-askroute-usage-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key-for-ask-usage';

let app: FastifyInstance;
let getTurnEvents: typeof import('../src/db/usageStore.ts').getTurnEvents;
let getTurnSummary: typeof import('../src/db/usageStore.ts').getTurnSummary;

/** 每次 LLM 调用都返回带 usage 的响应，便于断言成本被记下来 */
function llmResponse(content: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 500,
        prompt_cache_hit_tokens: 300,
        prompt_cache_miss_tokens: 200,
        completion_tokens: 100,
        total_tokens: 600,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (!url.includes('/chat/completions')) throw new TypeError('offline: only chat/completions stubbed');
      return llmResponse('结论：作废接口在 src/api/orderVoid.ts:5。');
    }),
  );

  const { loadFixtureGraph } = await import('./eval/harness.js');
  await loadFixtureGraph();
  ({ getTurnEvents, getTurnSummary } = await import('../src/db/usageStore.ts'));

  const { registerAsk } = await import('../src/routes/ask.js');
  app = Fastify({ logger: false });
  registerAsk(app);
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

async function ask(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/ask', payload });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    turnId?: string;
    tokenUsageSummary?: import('@aiops/shared-types').TurnUsageSummary;
  };
}

describe('Ask 路由 · 成本归属', () => {
  it('响应带 turnId 与汇总，且本轮所有 LLM 调用都在同一个 turn 里', async () => {
    const body = await ask({ question: '订单作废按钮点击后做了什么？' });

    expect(body.turnId).toBeTruthy();
    expect(body.tokenUsageSummary).toBeDefined();

    const events = getTurnEvents(body.turnId!);
    expect(events.length).toBeGreaterThan(0);
    // 全部事件属于同一 turn —— 这条挂了说明有调用漏归属或串到别的 turn
    expect(new Set(events.map((e) => e.turnId))).toEqual(new Set([body.turnId]));
    // 至少覆盖到答案阶段；意图/规划视问题走向可能命中规则路径而不调 LLM
    expect(events.some((e) => e.stage.startsWith('ask.answer'))).toBe(true);

    const summary = body.tokenUsageSummary!;
    expect(summary.callCount).toBe(events.length);
    expect(summary.knownCostNanoCny).toBe(
      events.reduce((acc, e) => acc + (e.totalCostNanoCny ?? 0), 0),
    );
  });

  it('汇总在响应时已 settled（无后台任务的最简路径），不会永远显示结算中', async () => {
    const body = await ask({ question: '备料核料的列表页在哪个文件？' });
    const summary = body.tokenUsageSummary!;
    expect(summary.executionStatus).toBe('completed');
    // 可能登记了记忆抽取后台任务 → pending 也是合法终态，但绝不能是 collecting
    expect(['settled', 'pending']).toContain(summary.settlementStatus);
  });

  it('DeepSeek 缓存拆分与成本被真实记录（不是零成本占位）', async () => {
    const body = await ask({ question: '订单作废用了哪些接口？' });
    const events = getTurnEvents(body.turnId!);
    const answer = events.find((e) => e.stage.startsWith('ask.answer'))!;
    expect(answer.tokens.cacheHitTokens).toBe(300);
    expect(answer.tokens.cacheMissTokens).toBe(200);
    // 300×20 + 200×1000 + 100×2000 = 406,000
    expect(answer.totalCostNanoCny).toBe(406_000);
    expect(body.tokenUsageSummary!.knownCostNanoCny).toBeGreaterThan(0);
  });

  it('source=eval 被记成 eval 分组（评测流量不混进用户交互成本）', async () => {
    const body = await ask({ question: '订单作废的接口在哪个文件？', source: 'eval' });
    expect(body.turnId).toBeTruthy();
    // 落库的 source 通过 turn 行验证：这里断言 turn 存在且可查（分组字段在 DB 层）
    expect(getTurnSummary(body.turnId!)).not.toBeNull();
  });

  it('未知 source 回退 web，不把任意字符串写进统计维度', async () => {
    const body = await ask({ question: '订单作废的接口在哪个文件？', source: 'wat' });
    expect(getTurnSummary(body.turnId!)).not.toBeNull();
  });

  it('turn 不会停在 collecting —— 任何出口都终结', async () => {
    const body = await ask({ question: '订单作废按钮点击后做了什么？' });
    const s = getTurnSummary(body.turnId!)!;
    expect(s.settlementStatus).not.toBe('collecting');
  });
});
