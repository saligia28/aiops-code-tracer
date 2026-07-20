/**
 * /api/agent/ask 的 plan 事件链路测试（P1-C 前端 checklist 的服务端半边）：
 *   1. agentLoop 发出的 plan 事件原样透传到 SSE；
 *   2. planSteps 落进 assistant 消息 meta（刷新/切会话后前端据此还原计划卡片）。
 * agentLoop 整体 mock 成事件剧本——这里验证的是路由的透传与持久化，不是循环本身。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-agentplan-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

const PLAN_STEPS = ['定位订货会价格核对页面组件', '追踪核价接口调用链', '汇总状态流转'];

vi.mock('../src/agent/index.js', () => ({
  agentLoop: vi.fn(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
    onEvent({ type: 'plan', data: { planSteps: PLAN_STEPS } });
    onEvent({ type: 'thinking', data: { thought: '先看页面入口' } });
    onEvent({ type: 'answer_delta', data: { delta: '结论：……' } });
    onEvent({ type: 'done', data: { answer: '结论：……', followUp: [] } });
  }),
}));

type Store = typeof import('../src/db/conversationStore.js');
let store: Store;
let app: FastifyInstance;

beforeAll(async () => {
  // 离线桩：记忆召回的 embedding 调用一律快速失败（走关键词回退）
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('offline: fetch disabled in agent plan route test');
  }));

  // 路由的 graphStore 存在性检查只看真值，mock 掉的 agentLoop 不会真用它
  const context = await import('../src/context.js');
  context.setGraphStore({} as never);

  const { registerAgent } = await import('../src/routes/agent.js');
  store = await import('../src/db/conversationStore.js');

  app = Fastify({ logger: false });
  registerAgent(app);
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

describe('/api/agent/ask · plan 事件透传与持久化', () => {
  it('plan 事件进 SSE 流；planSteps 落 assistant meta（前端还原计划卡片的依据）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/ask',
      payload: { question: '梳理订货会价格核对的完整链路' },
    });
    expect(res.statusCode).toBe(200);

    // SSE 透传：plan 事件带完整步骤
    const planLine = res.payload.split('\n').find((l) => l.includes('"type":"plan"'));
    expect(planLine).toBeTruthy();
    expect(planLine).toContain(PLAN_STEPS[0]);

    // 持久化：assistant 消息 meta 带 planSteps（restoreConversation 据此还原）
    const convLine = res.payload.split('\n').find((l) => l.includes('"type":"conversation"'));
    const convId = (JSON.parse(convLine!.slice(6)) as { data: { conversationId: string } }).data.conversationId;
    const messages = store.getMessages(convId);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.meta?.planSteps).toEqual(PLAN_STEPS);
  });
});
