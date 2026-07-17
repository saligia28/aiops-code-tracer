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

  it('getHistoryEntries：只含 user/assistant 非空消息、时间正序（窗口与摘要水位共用的唯一定义）', () => {
    const conv = store.createConversation('proj-entries');
    store.appendMessage(conv.id, { role: 'user', content: '第一问' });
    store.appendMessage(conv.id, { role: 'system', content: 'SYS 应被排除' });
    store.appendMessage(conv.id, { role: 'assistant', content: '第一答' });
    store.appendMessage(conv.id, { role: 'user', content: '' }); // 空内容应被排除
    store.appendMessage(conv.id, { role: 'user', content: '第二问' });
    store.appendMessage(conv.id, { role: 'assistant', content: '第二答' });

    const entries = store.getHistoryEntries(conv.id);
    expect(entries).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' },
    ]);
  });

  it('getHistoryEntries：同毫秒写入的消息保持插入序（rowid 次级排序，摘要水位的前提）', () => {
    const conv = store.createConversation('proj-tie');
    // 不 sleep，尽量制造同毫秒 created_at——无论是否同毫秒，插入序都必须稳定
    for (let i = 1; i <= 10; i++) {
      store.appendMessage(conv.id, { role: i % 2 === 1 ? 'user' : 'assistant', content: `m${i}` });
    }
    const entries = store.getHistoryEntries(conv.id);
    expect(entries.map((e) => e.content)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
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
