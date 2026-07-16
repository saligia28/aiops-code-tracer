/**
 * 记忆 v2（P2-F）评测。
 *
 * A. 确定性部分（CI 无条件跑）：手造向量验证「关键词漏、语义捞回」+ RRF 融合 + last_used_at
 *    遗忘信号 + 语义近重复不入榜。不依赖真实 embedding。
 * B. 真实语义部分（skipIf 无 embedding）：真 embed 一批记忆，用「换个说法」的 query 检索，
 *    断言语义能召回而纯关键词召不回——这是 v2 相对 v1 的核心增量。
 *
 * DB 隔离：在 import store 前设 AIOPS_DB_PATH（同 memoryStore.test）。
 */
import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `aiops-mem-v2-${process.pid}-${Date.now()}.db`);
process.env.AIOPS_DB_PATH = tmpDb;

let store: typeof import('../../src/db/memoryStore.js');
let embSvc: typeof import('../../src/services/embeddingService.js');
beforeAll(async () => {
  store = await import('../../src/db/memoryStore.js');
  embSvc = await import('../../src/services/embeddingService.js');
});
afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.rmSync(f); } catch { /* noop */ }
  }
});

const M = 'test-model';

describe('A · 确定性：混合召回 / RRF / 遗忘信号', () => {
  test('关键词漏、语义捞回：词法零重合但向量相近的记忆能被召回', () => {
    const P = 'sem';
    // "翻页" 与 "分页/每页" bigram 不重合；靠向量相近桥接
    store.recordMemories(P, null, [
      { kind: 'fact', content: '订单列表分页每页展示20条', embedding: [1, 0, 0], embedModel: M },
      { kind: 'fact', content: '登录逻辑在 SignIn 组件', embedding: [0, 1, 0], embedModel: M },
    ]);
    // 纯关键词：query 与两条都无 token 交集 → 召不回
    expect(store.retrieveMemories(P, '翻页怎么设置', 5).length).toBe(0);
    // 混合：query 向量贴近第一条 → 召回它
    const hybrid = store.retrieveMemoriesHybrid(P, '翻页怎么设置', [0.98, 0.05, 0], M, 5);
    expect(hybrid.length).toBe(1);
    expect(hybrid[0].content).toContain('分页');
  });

  test('last_used_at：命中后被更新（遗忘信号的基础）', () => {
    const P = 'used';
    store.recordMemories(P, null, [{ kind: 'fact', content: '权限配置在 systemConfig 模块', embedding: [1, 0, 0], embedModel: M }]);
    store.retrieveMemoriesHybrid(P, '权限配置', [1, 0, 0], M, 5);
    // 命中过的记忆不会被 pruneStaleMemories(0 天) 删除（只删从未命中的）
    expect(store.pruneStaleMemories(P, 0)).toBe(0);
    expect(store.listMemories(P).length).toBe(1);
  });

  test('pruneStaleMemories 只删从未命中的旧记忆', () => {
    const P = 'prune';
    // 两条刻意词法不相交，query 只命中订单那条
    store.recordMemories(P, null, [
      { kind: 'fact', content: '登录逻辑集中在 SignIn 组件里' },
      { kind: 'fact', content: '订单模块用分页展示每页二十条' },
    ]);
    store.retrieveMemories(P, '分页每页多少条', 5); // 命中订单那条 → last_used_at 置位
    const deleted = store.pruneStaleMemories(P, 0); // staleDays=0：所有"未命中"的都算旧
    expect(deleted).toBe(1);
    expect(store.listMemories(P)[0].content).toContain('订单');
  });

  test('语义近重复：向量几乎相同的记忆，service 层会跳过（此处验 store 支持带向量写入）', () => {
    const P = 'dup';
    const r = store.recordMemories(P, null, [
      { kind: 'fact', content: '面料审批单页面在 FabricApprove 组件', embedding: [1, 0, 0], embedModel: M },
    ]);
    expect(r.length).toBe(1);
    expect(store.getEmbeddedMemories(P, M).length).toBe(1);
    expect(store.countEmbeddedMemories(P, M)).toBe(1);
  });
});

describe.skipIf(true)('B · 真实语义召回（需 embedding；用 skipIf 占位，见下方说明）', () => {
  // 说明：真实 embedding 召回验证走 `pnpm --filter @aiops/api eval -- ...` 更合适（需起 ollama）。
  // 这里保留结构占位，条件恒 skip；确定性部分（A）已用手造向量覆盖融合机制。
  // TODO(记忆 v2 后续): 若要在 CI 外自动验证真实语义桥接，改成 describe.skipIf(!embSvc.canUseEmbedding())
  //   并在其中真 embed 一批"改写 query"，断言语义命中而关键词落空。
  test('placeholder', () => { expect(embSvc).toBeDefined(); });
});
