/**
 * /api/ask 路由级持久化语义测试（review 修复的自动化背书）。
 *
 * 覆盖三条此前只做过活体验证的行为：
 *   1. source:'mcp' 且无 conversationId → 完全无状态（会话/记忆表零增长，响应不带会话 id）
 *   2. source:'mcp' + 无效 conversationId → fork 新会话并照常落库，消息带 meta.source='mcp'
 *   3. 跨项目 conversationId → 视作无效并新开会话，外项目会话零消息污染
 *
 * 全程离线：global fetch 打桩为失败 → 所有 LLM/embedding 调用快速返回 null，
 * 管线走确定性规则路径；图谱用 fixture repo 现场构建（内存态，不碰 data/.aiops）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// 关键：在 import 任何 src 模块之前把 AIOPS_DB_PATH 指到临时文件
const TMP_DB = path.join(os.tmpdir(), `aiops-askroute-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

type Store = typeof import('../src/db/conversationStore.js');
let store: Store;
let sqlite: typeof import('../src/db/sqlite.js');
let app: FastifyInstance;
let projectId: string;

beforeAll(async () => {
  // 离线桩：LLM / embedding / Langfuse 全部走 global fetch，一律快速失败
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('offline: fetch disabled in route persistence test');
  }));

  const { loadFixtureGraph } = await import('./eval/harness.js');
  await loadFixtureGraph();

  const { resolveActiveProjectId } = await import('../src/context.js');
  projectId = resolveActiveProjectId();

  const { registerAsk } = await import('../src/routes/ask.js');
  store = await import('../src/db/conversationStore.js');
  sqlite = await import('../src/db/sqlite.js');

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

const countRows = (sql: string): number => (sqlite.getDb().prepare(sql).get() as { n: number }).n;

describe('/api/ask 持久化语义（source:mcp / 跨项目会话）', () => {
  it('source:mcp 无 conversationId：完全无状态——会话/记忆零增长、响应不带会话 id', async () => {
    const convBefore = countRows('SELECT COUNT(*) AS n FROM conversations');
    const memBefore = countRows('SELECT COUNT(*) AS n FROM memories');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: '登录按钮点击后做了什么？', source: 'mcp' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answer: string; conversationId?: string; repoName?: string };
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.conversationId).toBeUndefined();
    expect(body.repoName).toBeTruthy(); // 仓库标识必须下发（消费端切库感知）

    expect(countRows('SELECT COUNT(*) AS n FROM conversations')).toBe(convBefore);
    expect(countRows('SELECT COUNT(*) AS n FROM memories')).toBe(memBefore);
  });

  it('source:mcp + 无效 conversationId：fork 新会话并落库，消息带 meta.source=mcp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: '订单列表的数据从哪来？', source: 'mcp', conversationId: 'no-such-conversation' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversationId?: string };
    // fork：响应带的是新 id，不是请求里的无效 id
    expect(body.conversationId).toBeTruthy();
    expect(body.conversationId).not.toBe('no-such-conversation');

    const messages = store.getMessages(body.conversationId!);
    expect(messages.length).toBe(2); // user + assistant
    expect(messages.every((m) => m.meta?.source === 'mcp')).toBe(true);
  });

  it('跨项目 conversationId：视作无效并新开会话，外项目会话零消息污染', async () => {
    // 直接造一个属于其他项目的会话（等价于 Web 端切走项目后的旧会话）
    const foreign = store.createConversation('other-project-xyz', '外项目会话');
    expect(foreign.projectId).not.toBe(projectId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: '登录按钮点击后做了什么？', conversationId: foreign.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversationId?: string };
    // 不是 400：与"过期 id"同款降级——新开会话，响应回带新 id 供调用方感知
    expect(body.conversationId).toBeTruthy();
    expect(body.conversationId).not.toBe(foreign.id);
    // 外项目会话绝不能被写入
    expect(store.getMessages(foreign.id).length).toBe(0);
    // 新会话归属当前项目
    expect(store.getConversation(body.conversationId!)?.projectId).toBe(projectId);
  });
});
