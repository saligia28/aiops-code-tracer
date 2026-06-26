/**
 * memoryStore 单测：近重复去噪 + bigram 检索。纯确定性逻辑，不依赖 LLM。
 * 用临时 DB（AIOPS_DB_PATH），在 import store 之前设置，避免触碰真实 app.db。
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDb = path.join(os.tmpdir(), `aiops-mem-${process.pid}-${Date.now()}.db`);
process.env.AIOPS_DB_PATH = tmpDb;

let store: typeof import('../src/db/memoryStore.js');
beforeAll(async () => {
  store = await import('../src/db/memoryStore.js');
});
afterAll(() => {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.rmSync(f); } catch { /* noop */ }
  }
});

test('近重复去噪：完全相同跳过，明显不同保留', () => {
  const P = 'p1';
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '前端状态管理用 Vue2 data + mixin，未引入 Vuex' }]).length).toBe(1);
  // 完全相同 → 跳过
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '前端状态管理用 Vue2 data + mixin，未引入 Vuex' }]).length).toBe(0);
  // 明显不同 → 保留
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '登录逻辑集中在 SignIn.vue，调用 auth/login 接口' }]).length).toBe(1);
  expect(store.listMemories(P).length).toBe(2);
});

test('改写型近重复跳过；同组件的不同事实不误并', () => {
  const P = 'p5';
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '权限配置功能位于 systemConfig/permission 模块' }]).length).toBe(1);
  // 词序/标点微调的同义表述 → 跳过
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '权限配置功能位于 `systemConfig/permission` 模块中' }]).length).toBe(0);
  // 同组件但讲的是不同事实 → 保留
  expect(store.recordMemories(P, null, [{ kind: 'fact', content: '权限配置组件通过 props 接收 userId 和 postId' }]).length).toBe(1);
  expect(store.listMemories(P).length).toBe(2);
});

test('同批内去重', () => {
  const P = 'p2';
  const r = store.recordMemories(P, null, [
    { kind: 'fact', content: '完全一样的一条记忆内容示例' },
    { kind: 'fact', content: '完全一样的一条记忆内容示例' },
    { kind: 'fact', content: '另一条彻底不同的内容讲的是分页' },
  ]);
  expect(r.length).toBe(2);
});

test('bigram 检索命中相关记忆，不相关的不召回', () => {
  const P = 'p3';
  store.recordMemories(P, null, [
    { kind: 'fact', content: '登录逻辑在 SignIn.vue 组件中实现' },
    { kind: 'fact', content: '订单列表使用分页方式展示数据' },
  ]);
  const hits = store.retrieveMemories(P, '登录流程是怎样的', 5);
  expect(hits.length).toBe(1);
  expect(hits[0].content).toContain('登录');
});

test('删除', () => {
  const P = 'p4';
  const [m] = store.recordMemories(P, null, [{ kind: 'fact', content: '一条待删除的记忆内容示例' }]);
  store.deleteMemory(m.id);
  expect(store.listMemories(P).length).toBe(0);
});
