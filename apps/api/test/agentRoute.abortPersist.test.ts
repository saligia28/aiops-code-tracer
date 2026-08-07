/**
 * /api/agent/ask 中止落库测试(切会话中断修复·方案 B):
 * 客户端 SSE 中途断开 → 路由 abort 循环后,把已流出的部分答案 + meta.aborted 落库,
 * 会话里不再留下"只有提问没有回答"的空白孤儿轮。
 * agentLoop mock 成"发一帧 delta 后等 abort"的剧本;app.inject 无法模拟中途断开,
 * 用 app.listen + 真实 fetch abort 触发路由侧 reply.raw 'close'。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-agentabort-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

const PARTIAL = '结论:登录入口在 ';

vi.mock('../src/agent/index.js', () => ({
  agentLoop: vi.fn(async ({ onEvent, signal }: { onEvent: (e: unknown) => void; signal?: AbortSignal }) => {
    onEvent({ type: 'thinking', data: { thought: '先看入口' } });
    onEvent({ type: 'answer_delta', data: { delta: PARTIAL } });
    // 卡住直到客户端断连触发路由侧 abort——模拟"答案只流出一半"
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }),
}));

type Store = typeof import('../src/db/conversationStore.js');
let store: Store;
let app: FastifyInstance;
let baseUrl: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // 选择性离线桩:放行对本测试服务器的请求,其余(embedding/Langfuse)一律快速失败
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('http://127.0.0.1')) return realFetch(input, init);
    return Promise.reject(new TypeError('offline: fetch disabled in agent abort test'));
  }) as typeof fetch);

  const context = await import('../src/context.js');
  context.setGraphStore({} as never);

  const { registerAgent } = await import('../src/routes/agent.js');
  store = await import('../src/db/conversationStore.js');

  app = Fastify({ logger: false });
  registerAgent(app);
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

/** 轮询直到 probe 有值:断连后的落库发生在连接关闭之后,只能等 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('/api/agent/ask · 中止落库', () => {
  it('SSE 中途断连:部分答案 + meta.aborted 落库,无空白孤儿轮', async () => {
    const ctl = new AbortController();
    const resp = await fetch(`${baseUrl}/api/agent/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '登录在哪?' }),
      signal: ctl.signal,
    });
    expect(resp.status).toBe(200);

    // 读到 conversation 帧拿会话 id;读到 answer_delta 后立刻断开
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let convId = '';
    let buffer = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const evt = JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> };
        if (evt.type === 'conversation') convId = evt.data.conversationId as string;
        if (evt.type === 'answer_delta') break outer;
      }
    }
    ctl.abort();
    expect(convId).toBeTruthy();

    const assistant = await waitFor(() => store.getMessages(convId).find((m) => m.role === 'assistant'));
    expect(assistant.content).toBe(PARTIAL);
    expect(assistant.meta?.aborted).toBe(true);
    // 中止前的思考轨迹照常保留
    expect(Array.isArray(assistant.meta?.steps)).toBe(true);
  });
});
