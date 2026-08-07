/**
 * /api/ask SSE 中止落库测试(切会话中断修复·方案 B):
 * 流式回答中客户端断开 → 已流出的部分答案 + meta.aborted 落库。
 * llmService partial mock:流式调用与真实实现同契约(中止返回 {text, aborted:true});
 * canUseLlm/canAttemptStreamLlm 强制为 true,让管线真走到流式出口。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-askabort-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

const PARTIAL = '结论:点击后先校验';

vi.mock('../src/services/llmService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llmService.js')>();
  return {
    ...actual,
    canUseLlm: () => true,
    canAttemptStreamLlm: () => true,
    callChatCompletion: vi.fn(async () => null),
    callChatCompletionStream: vi.fn(
      async (_m: unknown, onDelta: (d: string) => void, signal?: AbortSignal) => {
        onDelta(PARTIAL);
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { text: PARTIAL, aborted: true };
      },
    ),
  };
});

let store: typeof import('../src/db/conversationStore.js');
let sqlite: typeof import('../src/db/sqlite.js');
let app: FastifyInstance;
let baseUrl: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('http://127.0.0.1')) return realFetch(input, init);
    return Promise.reject(new TypeError('offline: fetch disabled in ask abort test'));
  }) as typeof fetch);

  const { loadFixtureGraph } = await import('./eval/harness.js');
  await loadFixtureGraph();

  const { registerAsk } = await import('../src/routes/ask.js');
  store = await import('../src/db/conversationStore.js');
  sqlite = await import('../src/db/sqlite.js');

  app = Fastify({ logger: false });
  registerAsk(app);
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

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('/api/ask · SSE 中止落库', () => {
  it('流式回答中断连:部分答案 + meta.aborted 落库', async () => {
    const ctl = new AbortController();
    const resp = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '登录按钮点击后做了什么?', stream: true }),
      signal: ctl.signal,
    });
    expect(resp.status).toBe(200);

    // 读到第一帧 answer_delta 即断开(ask 的 SSE 协议里会话 id 只在 done 帧,这里事后查库)
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ') && line.includes('"answer_delta"')) break outer;
      }
    }
    ctl.abort();

    // 会话在请求入口即创建(user 消息先落库),取最新一条会话
    const convId = (
      sqlite.getDb().prepare('SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1').get() as { id: string }
    ).id;
    const assistant = await waitFor(() => store.getMessages(convId).find((m) => m.role === 'assistant'));
    expect(assistant.content).toBe(PARTIAL);
    expect(assistant.meta?.aborted).toBe(true);
  }, 10_000);
});
