import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// 关键：在 import store 之前把 AIOPS_DB_PATH 指到临时文件，绝不能碰真实 app.db。
const TMP_DB = path.join(os.tmpdir(), `aiops-conv-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

// store 在加载时会读取 AIOPS_DB_PATH，故用动态 import 确保上面的赋值先生效。
type Store = typeof import('../src/db/conversationStore.js');
let store: Store;

beforeAll(async () => {
  store = await import('../src/db/conversationStore.js');
});

afterAll(() => {
  // 清理临时 DB 文件（含 WAL/SHM 旁路文件）
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

describe('conversationStore', () => {
  it('create → get 往返', () => {
    const conv = store.createConversation('proj-a', '第一个会话');
    expect(conv.id).toBeTruthy();
    expect(conv.projectId).toBe('proj-a');
    expect(conv.title).toBe('第一个会话');
    expect(conv.archived).toBe(false);
    expect(conv.createdAt).toBeGreaterThan(0);
    expect(conv.updatedAt).toBe(conv.createdAt);

    const fetched = store.getConversation(conv.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(conv.id);
    expect(fetched!.title).toBe('第一个会话');
    expect(fetched!.archived).toBe(false);

    expect(store.getConversation('does-not-exist')).toBeNull();
  });

  it('listConversations 按项目过滤并按 updated_at DESC 排序', async () => {
    const projId = `proj-list-${crypto.randomUUID()}`;
    const c1 = store.createConversation(projId, 'c1');
    // 确保时间戳推进，避免同毫秒导致排序不稳定
    await new Promise((r) => setTimeout(r, 2));
    const c2 = store.createConversation(projId, 'c2');
    // 另一个项目，不应出现在结果里
    store.createConversation('other-proj', 'noise');

    let list = store.listConversations(projId);
    expect(list.map((c) => c.id)).toEqual([c2.id, c1.id]);

    // 给 c1 追加消息刷新 updated_at，应排到最前
    await new Promise((r) => setTimeout(r, 2));
    store.appendMessage(c1.id, { role: 'user', content: '动一下 c1' });
    list = store.listConversations(projId);
    expect(list[0].id).toBe(c1.id);
    expect(list.every((c) => c.projectId === projId)).toBe(true);
  });

  it('appendMessage 后 getMessages 顺序正确且刷新 updated_at', async () => {
    const conv = store.createConversation('proj-msg');
    const before = store.getConversation(conv.id)!.updatedAt;

    await new Promise((r) => setTimeout(r, 2));
    const m1 = store.appendMessage(conv.id, { role: 'user', content: '问题一' });
    await new Promise((r) => setTimeout(r, 2));
    const m2 = store.appendMessage(conv.id, {
      role: 'assistant',
      content: '回答一',
      mode: 'rag',
      meta: { followUp: ['再问'], elapsed: 42 },
    });

    const msgs = store.getMessages(conv.id);
    expect(msgs.map((m) => m.id)).toEqual([m1.id, m2.id]);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('问题一');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].mode).toBe('rag');
    // meta 经 JSON 往返还原为对象
    expect(msgs[1].meta).toEqual({ followUp: ['再问'], elapsed: 42 });

    const after = store.getConversation(conv.id)!.updatedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('getConversationWithMessages 返回会话与其消息', () => {
    const conv = store.createConversation('proj-with');
    store.appendMessage(conv.id, { role: 'user', content: 'hi' });
    const full = store.getConversationWithMessages(conv.id);
    expect(full).not.toBeNull();
    expect(full!.id).toBe(conv.id);
    expect(full!.messages.length).toBe(1);
    expect(store.getConversationWithMessages('nope')).toBeNull();
  });

  it('buildLlmHistory 按 token 预算截断：最旧先丢、只含 user/assistant、时间正序', () => {
    const conv = store.createConversation('proj-budget');
    // estimateTokens(s) = ceil(len/3)。构造长度可控的消息。
    const longU1 = 'U'.repeat(300); // ~100 token（最旧）
    const longA1 = 'A'.repeat(300); // ~100 token
    const longU2 = 'B'.repeat(300); // ~100 token
    const longA2 = 'C'.repeat(300); // ~100 token（最新）

    store.appendMessage(conv.id, { role: 'user', content: longU1 });
    store.appendMessage(conv.id, { role: 'system', content: 'SYS 应被排除' });
    store.appendMessage(conv.id, { role: 'assistant', content: longA1 });
    store.appendMessage(conv.id, { role: 'user', content: '' }); // 空内容应被排除
    store.appendMessage(conv.id, { role: 'user', content: longU2 });
    store.appendMessage(conv.id, { role: 'assistant', content: longA2 });

    // 预算 ~250 token：只容得下最新两条（longU2 + longA2 = 200），longA1(再 +100=300) 超预算被丢。
    const history = store.buildLlmHistory(conv.id, 250);
    expect(history).toEqual([
      { role: 'user', content: longU2 },
      { role: 'assistant', content: longA2 },
    ]);
    // 不含 system、不含空内容
    expect(history.some((h) => (h.role as string) === 'system')).toBe(false);
    expect(history.some((h) => h.content === '')).toBe(false);

    // 预算极大：拿到全部 user/assistant（4 条），时间正序
    const all = store.buildLlmHistory(conv.id, 1_000_000);
    expect(all.map((h) => h.content)).toEqual([longU1, longA1, longU2, longA2]);
  });

  it('renameConversation 改标题并刷新 updated_at', async () => {
    const conv = store.createConversation('proj-rename', '旧标题');
    const before = store.getConversation(conv.id)!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    store.renameConversation(conv.id, '新标题');
    const after = store.getConversation(conv.id)!;
    expect(after.title).toBe('新标题');
    expect(after.updatedAt).toBeGreaterThan(before);
  });

  it('deleteConversation 级联删消息', () => {
    const conv = store.createConversation('proj-del');
    store.appendMessage(conv.id, { role: 'user', content: 'q' });
    store.appendMessage(conv.id, { role: 'assistant', content: 'a' });
    expect(store.getMessages(conv.id).length).toBe(2);

    store.deleteConversation(conv.id);
    expect(store.getConversation(conv.id)).toBeNull();
    expect(store.getMessages(conv.id).length).toBe(0);
  });
});
