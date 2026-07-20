/**
 * /api/trace、/api/why 的 file 入参路由级测试（P1-MCP：get_impact_scope 文件模式）。
 * fixture repo 现场建图，全程离线、确定性：
 *   - 文件级聚合只返回跨文件影响（内部边是噪声）
 *   - 短文件名唯一命中可用；多命中（fixture 有 3 个 List.vue）返回候选而非静默选一个
 *   - symbol/file 同传 400；未知文件 FILE_NOT_FOUND
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';

let app: FastifyInstance;

beforeAll(async () => {
  const { loadFixtureGraph } = await import('./eval/harness.js');
  await loadFixtureGraph();

  const { registerTrace } = await import('../src/routes/trace.js');
  app = Fastify({ logger: false });
  registerTrace(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

interface ImpactResp {
  file?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  message?: string;
  candidates?: string[];
  sourceSymbols?: number;
}

const ORDER_LIST = 'src/views/orderManage/orderVoid/List.vue';
const ORDER_API = 'src/api/orderVoid.ts';

describe('/api/trace · file 入参（下游依赖）', () => {
  it('完整路径：聚合文件符号、只留跨文件影响（订单作废页 → api/orderVoid.ts）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/trace?file=${encodeURIComponent(ORDER_LIST)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ImpactResp;
    expect(body.message).toBeUndefined();
    expect(body.file).toBe(ORDER_LIST);
    expect(body.sourceSymbols).toBeGreaterThan(0);
    // 下游应跨出到接口文件
    expect(body.nodes.some((n) => n.filePath === ORDER_API)).toBe(true);
    // 纯文件内部边不允许出现：每条边至少一端在文件外
    const byId = new Map(body.nodes.map((n) => [n.id, n] as const));
    for (const e of body.edges) {
      const fromIn = byId.get(e.from)?.filePath === ORDER_LIST || e.from.includes(`:${ORDER_LIST}:`);
      const toIn = byId.get(e.to)?.filePath === ORDER_LIST || e.to.includes(`:${ORDER_LIST}:`);
      expect(fromIn && toIn).toBe(false);
    }
  });

  it('短文件名多命中（fixture 有 3 个 List.vue）：返回候选，绝不静默选一个', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trace?file=List.vue' });
    const body = res.json() as ImpactResp;
    expect(body.message).toBe('FILE_AMBIGUOUS');
    expect(body.candidates!.length).toBeGreaterThanOrEqual(3);
    expect(body.candidates).toContain(ORDER_LIST);
    expect(body.nodes).toEqual([]);
  });

  it('短文件名唯一命中：解析为完整路径正常聚合', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trace?file=detail.vue' });
    const body = res.json() as ImpactResp;
    expect(body.message).toBeUndefined();
    expect(body.file).toBe('src/views/orderManage/orderVoid/detail.vue');
    expect(body.sourceSymbols).toBeGreaterThan(0);
  });

  it('未知文件 → FILE_NOT_FOUND；symbol/file 同传 → 400', async () => {
    const notFound = (await app.inject({ method: 'GET', url: '/api/trace?file=nope.vue' })).json() as ImpactResp;
    expect(notFound.message).toBe('FILE_NOT_FOUND');

    const both = await app.inject({ method: 'GET', url: `/api/trace?file=${encodeURIComponent(ORDER_LIST)}&symbol=x` });
    expect(both.statusCode).toBe(400);
  });
});

describe('/api/why · file 入参（上游影响面）', () => {
  it('api/orderVoid.ts 的上游应包含调用它的订单作废页面', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/why?file=${encodeURIComponent(ORDER_API)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ImpactResp;
    expect(body.message).toBeUndefined();
    expect(body.nodes.some((n) => n.filePath === ORDER_LIST)).toBe(true);
  });

  it('target/file 同传 → 400；symbol 老路径行为不变（回归护栏）', async () => {
    const both = await app.inject({ method: 'GET', url: `/api/why?file=${encodeURIComponent(ORDER_API)}&target=x` });
    expect(both.statusCode).toBe(400);

    const legacy = await app.inject({ method: 'GET', url: '/api/why?target=voidOrder' });
    expect(legacy.statusCode).toBe(200);
    const body = legacy.json() as ImpactResp & { target?: string };
    // 符号存在与否都行，但响应结构必须是老形状（nodes/edges 数组）
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });
});
