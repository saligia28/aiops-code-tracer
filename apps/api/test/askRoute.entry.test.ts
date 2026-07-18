/**
 * /api/ask 的 entry 入口字段（P1-MCP·additive 下沉）确定性验收 —— D1「入口对不对」的 CI gate。
 *
 * 关键：entry(anchor/startNode) 在 Step 1~2 由图谱+规则算出，**在 LLM 调用之前**，故本套件
 * 可全程离线（global fetch 打桩失败 → 所有 LLM/embedding 快速返回 null，管线走确定性规则路径）
 * + fixture repo 现场建图，稳定判定，永不 skip。
 *
 * gold（file 粒度，见 eval/types.ts 的标注哲学）：订单作废链路的入口应落在 orderVoid 页面/接口文件。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// 在 import 任何 src 模块之前把 DB 指到临时文件（与 askRoute.persistence.test 同款）
const TMP_DB = path.join(os.tmpdir(), `aiops-askroute-entry-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

let app: FastifyInstance;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('offline: fetch disabled in entry test');
  }));

  const { loadFixtureGraph } = await import('./eval/harness.js');
  await loadFixtureGraph();

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

interface EntryResp {
  entry?: { file: string; line?: number; symbol?: string; reason: string };
  evidence: Array<{ file: string; line: number }>;
  repoName?: string;
}

describe('/api/ask entry 入口下沉（P1-MCP·additive）', () => {
  it('订单作废按钮点击后做了什么？→ entry 命中 orderVoid 链路且是真实文件（D1 入口对不对）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: '订单作废按钮点击后做了什么？', source: 'mcp' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EntryResp;

    // entry 必须下发（该问题必有页面锚点/图谱起点）
    expect(body.entry).toBeDefined();
    expect(body.entry!.file).toBeTruthy();
    expect(body.entry!.reason).toBeTruthy();

    // D1「入口对不对」：落在订单作废链路（页面或接口文件），file 粒度判定
    expect(body.entry!.file).toMatch(/orderVoid/);

    // 可执行前提：entry.file 是真实被检索/建图到的文件（在证据里，或就是 orderVoid 源文件）
    const evidenceFiles = new Set(body.evidence.map((e) => e.file));
    const isRealFile =
      evidenceFiles.has(body.entry!.file) ||
      /orderVoid\/(List|detail)\.vue$|api\/orderVoid\.ts$/.test(body.entry!.file);
    expect(isRealFile).toBe(true);
  });

  it('纯定位/无锚点问题不硬造 entry（可选字段，缺省即缺省，零侵入现状）', async () => {
    // 与业务实体无关、匹配不到任何页面锚点的问题：entry 允许缺省，但绝不能报错或伪造
    const res = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: 'zzz_nonexistent_symbol_qqq 在哪里定义？', source: 'mcp' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as EntryResp;
    // 若下发了 entry，则必须结构完整（file+reason）——不接受半成品
    if (body.entry) {
      expect(body.entry.file).toBeTruthy();
      expect(body.entry.reason).toBeTruthy();
    }
  });
});
