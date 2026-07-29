/**
 * 成本追踪 · 阶段 3：adapter 采集（llmService / llmWithTools）。
 *
 * 盯的是"钱从哪来"这一层：供应商返回什么、我们记下什么。
 * 用真临时 DB + 打桩 fetch —— usage 解析、错误分类、流式末帧这些只有走真实代码路径才算数。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const TMP_DB = path.join(os.tmpdir(), `aiops-usage-adapter-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key-for-usage-suite';

const { createUsageTracker } = await import('../src/services/usage/usageTracker.ts');
const { getTurnEvents } = await import('../src/db/usageStore.ts');
const { callChatCompletion, callChatCompletionStream } = await import('../src/services/llmService.ts');
const { callChatCompletionWithTools } = await import('../src/agent/llmWithTools.ts');

const MESSAGES = [{ role: 'user' as const, content: '订单作废在哪实现？' }];

afterAll(() => {
  vi.unstubAllGlobals();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

function tracker() {
  return createUsageTracker({ projectId: 'p1', pipeline: 'ask', source: 'web' });
}

/** DeepSeek 非流式响应体（带缓存拆分） */
function deepseekJson(usage?: Record<string, number>) {
  return {
    choices: [{ message: { content: '结论：见 src/api/orderVoid.ts:5。' } }],
    usage: usage ?? {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 400,
      completion_tokens: 200,
      total_tokens: 1200,
    },
  };
}

function stubFetch(impl: (url: string, init?: { body?: string }) => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { body?: string }) => impl(String(input), init)));
}

beforeEach(() => vi.unstubAllGlobals());

describe('llmService 非流式采集', () => {
  it('DeepSeek usage 全解析并按官方价算钱', async () => {
    stubFetch(() => new Response(JSON.stringify(deepseekJson()), { status: 200 }));
    const t = tracker();
    await callChatCompletion(MESSAGES, undefined, { tracker: t, stage: 'ask.answer_complex' });

    const [e] = getTurnEvents(t.turnId);
    expect(e.stage).toBe('ask.answer_complex');
    expect(e.deliveryMode).toBe('non_stream');
    expect(e.transportStatus).toBe('success');
    expect(e.usageSource).toBe('provider');
    expect(e.tokens).toMatchObject({ cacheHitTokens: 600, cacheMissTokens: 400, completionTokens: 200 });
    // 600×20 + 400×1000 + 200×2000 = 812,000 nano-CNY
    expect(e.totalCostNanoCny).toBe(812_000);
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('HTTP 5xx：记 error + http_5xx，usage 缺失但调用仍计数', async () => {
    stubFetch(() => new Response('upstream boom', { status: 503 }));
    const t = tracker();
    await callChatCompletion(MESSAGES, undefined, { tracker: t, stage: 'ask.intent' });

    const [e] = getTurnEvents(t.turnId);
    expect(e.transportStatus).toBe('error');
    expect(e.errorKind).toBe('http_5xx');
    expect(e.usageSource).toBe('missing');
    expect(e.totalCostNanoCny).toBeUndefined();
    // 错误响应正文绝不入库
    expect(JSON.stringify(e)).not.toContain('boom');
  });

  it('缺缓存拆分的代理响应 → estimated（成本按全未命中的上界）', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
        { status: 200 },
      ),
    );
    const t = tracker();
    await callChatCompletion(MESSAGES, undefined, { tracker: t, stage: 'ask.answer_simple' });

    const [e] = getTurnEvents(t.turnId);
    expect(e.usageSource).toBe('estimated');
    expect(e.tokens.cacheMissTokens).toBe(100);
    expect(e.totalCostNanoCny).toBe(100 * 1000 + 10 * 2000);
  });

  it('不传 usageContext 时完全不记账（离线单测/无 turn 场景）', async () => {
    stubFetch(() => new Response(JSON.stringify(deepseekJson()), { status: 200 }));
    const t = tracker();
    await callChatCompletion(MESSAGES); // 无 usage 参数
    expect(getTurnEvents(t.turnId)).toHaveLength(0);
  });
});

describe('llmService 流式采集', () => {
  function sseResponse(chunks: string[]): Response {
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  it('末帧带 usage：success + deliveryMode=stream', async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":50,"prompt_cache_hit_tokens":50,"prompt_cache_miss_tokens":0,"completion_tokens":8,"total_tokens":58}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const t = tracker();
    await callChatCompletionStream(MESSAGES, () => {}, undefined, { tracker: t, stage: 'ask.answer_complex' });

    const [e] = getTurnEvents(t.turnId);
    expect(e.deliveryMode).toBe('stream');
    expect(e.transportStatus).toBe('success');
    expect(e.tokens.cacheHitTokens).toBe(50);
    expect(e.totalCostNanoCny).toBe(50 * 20 + 8 * 2000);
  });

  it('末帧没到（token 已真实消耗但拿不到数）→ error + stream_incomplete + missing', async () => {
    stubFetch(() => sseResponse(['data: {"choices":[{"delta":{"content":"半"}}]}\n\n']));
    const t = tracker();
    await callChatCompletionStream(MESSAGES, () => {}, undefined, { tracker: t, stage: 'ask.answer_complex' });

    const [e] = getTurnEvents(t.turnId);
    expect(e.transportStatus).toBe('error');
    expect(e.errorKind).toBe('stream_incomplete');
    expect(e.usageSource).toBe('missing');
  });

  it('流式失败后回退非流式 = 两条不同 stage 的 event，两次都真实计费', async () => {
    // 第一次（流式）没有末帧 usage，第二次（非流式）正常返回
    let call = 0;
    stubFetch(() => {
      call += 1;
      return call === 1
        ? sseResponse(['data: {"choices":[{"delta":{"content":"半"}}]}\n\n'])
        : new Response(JSON.stringify(deepseekJson()), { status: 200 });
    });

    const t = tracker();
    await callChatCompletionStream(MESSAGES, () => {}, undefined, { tracker: t, stage: 'ask.answer_complex' });
    await callChatCompletion(MESSAGES, undefined, { tracker: t, stage: 'ask.answer_complex_fallback' });

    const events = getTurnEvents(t.turnId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.stage)).toEqual(['ask.answer_complex', 'ask.answer_complex_fallback']);
    // 两次都算钱：fallback 不是重复记录，是真的又调了一次
    expect(t.summary().callCount).toBe(2);
    expect(t.summary().knownCostNanoCny).toBe(812_000);
  });
});

describe('agent adapter 采集', () => {
  const agentOpts = {
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'k',
  };

  it('工具轮与最终答案都记 agent.loop，序号递增', async () => {
    stubFetch(() => new Response(JSON.stringify(deepseekJson()), { status: 200 }));
    const t = tracker();
    for (let i = 0; i < 2; i++) {
      await callChatCompletionWithTools(
        [{ role: 'user', content: 'q' }],
        [],
        { ...agentOpts, usage: { tracker: t, stage: 'agent.loop' } },
      );
    }
    const events = getTurnEvents(t.turnId);
    expect(events.map((e) => e.stageCallIndex)).toEqual([0, 1]);
    expect(events.every((e) => e.stage === 'agent.loop')).toBe(true);
  });

  it('HTTP 错误：先记账再抛，调用不会从账本上消失', async () => {
    stubFetch(() => new Response('nope', { status: 429 }));
    const t = tracker();
    await expect(
      callChatCompletionWithTools([{ role: 'user', content: 'q' }], [], {
        ...agentOpts,
        usage: { tracker: t, stage: 'agent.planner' },
      }),
    ).rejects.toThrow();

    const [e] = getTurnEvents(t.turnId);
    expect(e.stage).toBe('agent.planner');
    expect(e.transportStatus).toBe('error');
    expect(e.errorKind).toBe('http_4xx');
  });

  it('Ollama 顶层 token 字段（prompt_eval_count/eval_count）也能解析', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ message: { content: '答案' }, prompt_eval_count: 300, eval_count: 40 }), {
        status: 200,
      }),
    );
    const t = tracker();
    await callChatCompletionWithTools([{ role: 'user', content: 'q' }], [], {
      provider: 'ollama',
      model: 'qwen3:8b',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      usage: { tracker: t, stage: 'agent.loop' },
    });

    const [e] = getTurnEvents(t.turnId);
    expect(e.tokens.promptTokens).toBe(300);
    expect(e.tokens.completionTokens).toBe(40);
    // 本地模型没配价：Token 可见、金额未知，绝不记成 ¥0
    expect(e.totalCostNanoCny).toBeUndefined();
    expect(t.summary().unknownPricingCalls).toBe(1);
  });
});
