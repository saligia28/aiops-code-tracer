import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { estimateTokens } from '../src/services/ask/textUtils.js';

// 关键：在 import store 之前把 AIOPS_DB_PATH 指到临时文件，绝不能碰真实 app.db。
const TMP_DB = path.join(os.tmpdir(), `aiops-hist-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;
// 固定「保留最近条数」为 2，测试对 KEEP_RECENT 语义的断言不受默认值调整影响
process.env.HISTORY_KEEP_RECENT = '2';

type Store = typeof import('../src/db/conversationStore.js');
type Compactor = typeof import('../src/services/ask/historyCompactor.js');
let store: Store;
let compactor: Compactor;

beforeAll(async () => {
  store = await import('../src/db/conversationStore.js');
  compactor = await import('../src/services/ask/historyCompactor.js');
});

afterAll(() => {
  delete process.env.HISTORY_KEEP_RECENT;
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

// ASCII 内容 token = len/4，长度可控
const msg = (role: 'user' | 'assistant', ch: string, tokens: number) => ({
  role,
  content: ch.repeat(tokens * 4),
});

describe('assembleHistoryWindow · 纯函数窗口装配', () => {
  it('全部装得下：与 v1 完全一致，摘要即使存在也不注入（原文保真度优先）', () => {
    const entries = [msg('user', 'a', 50), msg('assistant', 'b', 50)];
    const r = compactor.assembleHistoryWindow(entries, { summary: '旧摘要', covered: 1 }, 1000);
    expect(r.messages).toEqual(entries);
    expect(r.needsCompaction).toBe(false);
    expect(r.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('装不下且无摘要：v1 截断（最旧先丢）+ 请求后台压缩', () => {
    const entries = [msg('user', 'a', 100), msg('assistant', 'b', 100), msg('user', 'c', 100)];
    const r = compactor.assembleHistoryWindow(entries, null, 250);
    expect(r.messages.map((m) => m.content[0])).toEqual(['b', 'c']);
    expect(r.needsCompaction).toBe(true);
  });

  it('装不下且有摘要：摘要以 system 消息顶上 + 未覆盖消息从新到旧装填', () => {
    const entries = [
      msg('user', 'a', 100), // covered
      msg('assistant', 'b', 100), // covered
      msg('user', 'c', 100),
      msg('assistant', 'd', 100),
    ];
    const summary = { summary: '早期讨论了订单页', covered: 2 };
    const summaryCost = estimateTokens(`${compactor.SUMMARY_PREFIX}${summary.summary}`);
    // 预算 = 摘要 + 两条未覆盖消息，刚好全装下 → 无消息被丢，不再触发压缩
    const r = compactor.assembleHistoryWindow(entries, summary, summaryCost + 200);
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[0].content).toContain('早期讨论了订单页');
    expect(r.messages.slice(1).map((m) => m.content[0])).toEqual(['c', 'd']);
    expect(r.needsCompaction).toBe(false);
  });

  it('摘要顶上后未覆盖部分仍装不下：needsCompaction=true（等下一次压缩推进水位）', () => {
    const entries = [
      msg('user', 'a', 100), // covered
      msg('user', 'c', 100),
      msg('assistant', 'd', 100),
    ];
    const summary = { summary: '早期结论', covered: 1 };
    const summaryCost = estimateTokens(`${compactor.SUMMARY_PREFIX}${summary.summary}`);
    // 预算只够摘要 + 1 条：c 被丢
    const r = compactor.assembleHistoryWindow(entries, summary, summaryCost + 100);
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'assistant']);
    expect(r.needsCompaction).toBe(true);
  });

  it('单条超长消息不堵死窗口：溢出路径按 token 钳制后装填（保住用户问题与答案头部）', () => {
    // 最新一轮是 1000 token 的长答案：v1 语义下它第一个撞预算即 break，窗口全空
    const entries = [msg('user', 'q', 10), msg('assistant', 'a', 1000)];
    const r = compactor.assembleHistoryWindow(entries, null, 300);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0].content[0]).toBe('q');
    expect(r.messages[1].content).toContain('（此轮全文过长已截断）');
    expect(estimateTokens(r.messages[1].content)).toBeLessThanOrEqual(280);
    expect(r.needsCompaction).toBe(false);
  });

  it('摘要本身超预算（预算被调得极小）：退回 v1 截断，摘要不独占窗口', () => {
    const entries = [msg('user', 'a', 100), msg('assistant', 'b', 10)];
    const r = compactor.assembleHistoryWindow(entries, { summary: 'S'.repeat(4000), covered: 1 }, 50);
    expect(r.messages.some((m) => m.role === 'system')).toBe(false);
    expect(r.messages.map((m) => m.content[0])).toEqual(['b']);
    expect(r.needsCompaction).toBe(true);
  });
});

describe('compactHistory · 摘要生成与水位推进（fake summarizer，确定性）', () => {
  it('首次压缩：覆盖到「除最近 KEEP_RECENT(2) 条外」，transcript 带角色前缀', async () => {
    const conv = store.createConversation('proj-compact', '压缩测试');
    for (let i = 1; i <= 6; i++) {
      store.appendMessage(conv.id, { role: i % 2 === 1 ? 'user' : 'assistant', content: `第${i}条消息` });
    }

    let seenPrompt = '';
    const ok = await compactor.compactHistory(conv.id, async (messages) => {
      seenPrompt = messages.map((m) => m.content).join('\n---\n');
      return '用户讨论了前 4 条消息的主题';
    });
    expect(ok).toBe(true);

    const s = store.getConversationSummary(conv.id);
    expect(s).toEqual({ summary: '用户讨论了前 4 条消息的主题', covered: 4 });
    // transcript 只含被覆盖的前 4 条，带角色前缀；最近 2 条不进摘要
    expect(seenPrompt).toContain('用户：第1条消息');
    expect(seenPrompt).toContain('助手：第4条消息');
    expect(seenPrompt).not.toContain('第5条消息');
    expect(seenPrompt).not.toContain('第6条消息');
  });

  it('目标覆盖已达成时 no-op（重复触发收敛，不空转 LLM）', async () => {
    const conv = store.createConversation('proj-noop');
    for (let i = 1; i <= 3; i++) store.appendMessage(conv.id, { role: 'user', content: `m${i}` });
    await compactor.compactHistory(conv.id, async () => '摘要');
    const again = await compactor.compactHistory(conv.id, async () => {
      throw new Error('不应被调用');
    });
    expect(again).toBe(false);
  });

  it('增量压缩：旧摘要并入 prompt，水位继续推进', async () => {
    const conv = store.createConversation('proj-merge');
    for (let i = 1; i <= 4; i++) store.appendMessage(conv.id, { role: 'user', content: `早期-${i}` });
    await compactor.compactHistory(conv.id, async () => '第一版摘要');
    expect(store.getConversationSummary(conv.id)?.covered).toBe(2);

    for (let i = 5; i <= 8; i++) store.appendMessage(conv.id, { role: 'user', content: `后期-${i}` });
    let seenPrompt = '';
    await compactor.compactHistory(conv.id, async (messages) => {
      seenPrompt = messages.map((m) => m.content).join('\n');
      return '合并后的摘要';
    });
    expect(seenPrompt).toContain('已有早期摘要');
    expect(seenPrompt).toContain('第一版摘要');
    expect(store.getConversationSummary(conv.id)).toEqual({ summary: '合并后的摘要', covered: 6 });
  });

  it('LLM 摘要超长（无视"300 字以内"指令）：按 token 钳制后写入，绝不挤爆历史预算', async () => {
    const conv = store.createConversation('proj-clamp');
    for (let i = 1; i <= 5; i++) store.appendMessage(conv.id, { role: 'user', content: `c${i}` });
    // CJK 为主的超长摘要（按字符卡会低估 token 近 5 倍的场景）
    const ok = await compactor.compactHistory(conv.id, async () => '摘'.repeat(2000));
    expect(ok).toBe(true);
    const s = store.getConversationSummary(conv.id)!;
    expect(estimateTokens(compactor.SUMMARY_PREFIX + s.summary)).toBeLessThanOrEqual(400);
  });

  it('LLM 返回空：不写入、水位不动（失败不降级已有摘要）', async () => {
    const conv = store.createConversation('proj-null');
    for (let i = 1; i <= 5; i++) store.appendMessage(conv.id, { role: 'user', content: `n${i}` });
    const ok = await compactor.compactHistory(conv.id, async () => null);
    expect(ok).toBe(false);
    expect(store.getConversationSummary(conv.id)).toBeNull();
  });
});

describe('contextualizeQuestion · 指代补全（活体验证暴露的缺口）', () => {
  const hist = [
    { role: 'user', content: '订单会议核价的列表页在哪个文件？' },
    { role: 'assistant', content: '在 qsOrderMeetingPriceCheck/List.vue' },
  ];

  it('指代型追问 + 有历史：拼上一轮用户问题补全检索语境', () => {
    const q = '这个核价列表页所在的完整目录路径是什么？';
    const r = compactor.contextualizeQuestion(q, hist);
    expect(r).toBe(`订单会议核价的列表页在哪个文件？ ${q}`);
  });

  it('无指代词：原样返回（正常问题不背历史包袱）', () => {
    const q = '约仓发货的页面在哪里实现的？';
    expect(compactor.contextualizeQuestion(q, hist)).toBe(q);
  });

  it('无历史：原样返回（单轮评测门禁零变化）', () => {
    const q = '这个页面用了哪些接口？';
    expect(compactor.contextualizeQuestion(q, [])).toBe(q);
  });

  it('长会话（用户轮已折进摘要）：摘要头部进检索语境——指称对象往往只活在摘要里', () => {
    const q = '这个核价列表页在哪个目录？';
    const r = compactor.contextualizeQuestion(q, [
      { role: 'system', content: `${compactor.SUMMARY_PREFIX}用户询问订单会议核价列表页，定位到 qsOrderMeetingPriceCheck/List.vue` },
    ]);
    expect(r).toContain('qsOrderMeetingPriceCheck');
    expect(r).toContain(q);
    expect(r).not.toContain(compactor.SUMMARY_PREFIX);
  });

  it('多条用户轮：只带与问题有词元重叠的轮，无关轮过滤（防竞争锚点带偏检索）', () => {
    const multi = [
      { role: 'user', content: '备料核料的列表页在哪个文件？' },
      { role: 'assistant', content: 'stockCheck/List.vue' },
      { role: 'user', content: '约仓发货的页面在哪里实现的？' },
      { role: 'assistant', content: 'BookWarehouseSend.vue' },
    ];
    const r = compactor.contextualizeQuestion('回到最开始问的备料核料，它的列表页文件是哪一个？', multi);
    expect(r).toContain('备料核料的列表页在哪个文件？');
    // 约仓发货与当前问题零词元重叠——拼进去只会制造竞争锚点（评测 a-mt-earliest-turn 教训）
    expect(r).not.toContain('约仓发货');
  });

  it('纯指代问题（自身无内容词）：兜底取最近一条用户轮', () => {
    const r = compactor.contextualizeQuestion('这个页面用了哪些接口？', hist);
    expect(r).toBe('订单会议核价的列表页在哪个文件？ 这个页面用了哪些接口？');
  });
});

describe('buildHistoryWindow · 路由入口', () => {
  it('短会话：返回原文窗口，与 buildLlmHistory 行为一致', () => {
    const conv = store.createConversation('proj-window');
    store.appendMessage(conv.id, { role: 'user', content: '问题' });
    store.appendMessage(conv.id, { role: 'assistant', content: '回答' });
    const win = compactor.buildHistoryWindow(conv.id, 1000);
    expect(win).toEqual(store.buildLlmHistory(conv.id, 1000));
    expect(win.map((m) => m.content)).toEqual(['问题', '回答']);
  });

  it('有缓存摘要的长会话：窗口 = 摘要 + 最近原文', async () => {
    const conv = store.createConversation('proj-window-sum');
    for (let i = 1; i <= 6; i++) {
      store.appendMessage(conv.id, { role: i % 2 === 1 ? 'user' : 'assistant', content: `长内容${i}-` + 'x'.repeat(200) });
    }
    await compactor.compactHistory(conv.id, async () => '前四条的摘要');
    // 预算不足以装下全部 6 条（每条 ~57 token，共 ~340），但够摘要 + 最近 2 条
    const win = compactor.buildHistoryWindow(conv.id, 150);
    expect(win[0].role).toBe('system');
    expect(win[0].content).toContain('前四条的摘要');
    expect(win.some((m) => m.content.startsWith('长内容6'))).toBe(true);
  });
});
