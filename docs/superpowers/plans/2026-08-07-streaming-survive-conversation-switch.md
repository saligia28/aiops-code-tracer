# Streaming 跨会话切换不中断(A)+ 中止落库部分答案(B)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新对话 streaming 中切换到其他历史会话再切回时,流继续、打字机无缝续上(A);任何真中断(停止按钮/刷新/关标签/切项目)后,已生成的部分答案与"已中止"标记落库,不再出现"只有提问、AI 回答空白"的孤儿轮(B)。

**Architecture:** A 在前端把"正在 streaming 的一轮"从 `AnswerView` 的 `history`(视图投影)中拆出,由模块级单例 `useStreamSession` 持有(key + turns 数组引用 + AbortController);切会话只换投影,不再 abort fetch;切回时按 key 还原内存 turns。B 在后端两条路由的中止出口补落库:agent 路由累积 `answer_delta` 后按 `partialAnswer + meta.aborted` 写 assistant 消息;ask 路由在三个 SSE 中止出口调用统一的 `persistAbortedTurn` helper。

**Tech Stack:** Vue 3 (composition API) + Fastify SSE + better-sqlite3;测试用 vitest(api 侧已有路由级 SSE 测试范式,web 侧已有 node 环境 composable 单测范式)。

---

## 背景:根因链(已确认,不再复查)

1. [AnswerView.vue:478](../../../apps/web/src/views/AnswerView.vue) `switchConversation` 里 `if (isAnyLoading.value) handleAbort()` 主动掐断 fetch——因为单一 `history` 数组承载当前视图,streaming turn 无处安放。
2. 后端把断连当取消:[agent.ts:70-72](../../../apps/api/src/routes/agent.ts) `reply.raw.on('close') → abortCtl.abort()`;且 [agent.ts:198](../../../apps/api/src/routes/agent.ts) `if (convId && finalAnswer)` 在中止时 `finalAnswer` 恒为空 → assistant 消息不落库。[ask.ts:699-704](../../../apps/api/src/routes/ask.ts) 明写"用户中断:不落库"。
3. 切回时 `loadConversation` 从库还原,只剩孤儿 user 消息 → `messagesToTurns` 生成 `loading:false, answer:''` 的 turn → 模板落入空白 `answer-content` 分支。

关键已确认事实(写代码时直接依赖,不用再验证):
- `callChatCompletionStream` 中止时**不抛异常**,返回 `{ text: 已累积部分文本, aborted: true }`([llmService.ts:398-511](../../../apps/api/src/services/llmService.ts))。
- `composeAnswerWithLlm` 中止时返回已累积部分文本([answer.ts:572](../../../apps/api/src/services/ask/answer.ts))。
- 前端 `messagesToTurns` 已支持从 `meta.aborted` 还原中止标记([useConversation.ts:151-153](../../../apps/web/src/composables/useConversation.ts)),B 落库后前端还原链路现成。
- `appendMessage(convId, {role, content, mode, meta})` 返回含 `.id` 的消息([conversationStore.ts:172](../../../apps/api/src/db/conversationStore.ts));`updateMessageMeta` 是 patch 合并语义。
- `usageTracker.finish()` 幂等,首个调用生效。
- api 路由级测试范式:`agentRoute.plan.test.ts`(mock agentLoop 事件剧本 + 临时 DB);`askRoute.persistence.test.ts`(fixture graph + 离线 fetch 桩)。**app.inject 无法模拟中途断连**,中止测试需 `app.listen({port:0})` + 真实 fetch abort。

## 文件结构

**Create:**
- `apps/web/src/composables/useStreamSession.ts` — 流会话单例:key/conversationId/turns 引用/ctrl,begin/attach/end + 临时 key 铸造
- `apps/web/tests/useStreamSession.test.ts` — 单例生命周期与重挂语义单测
- `apps/api/test/agentRoute.abortPersist.test.ts` — agent 路由断连 → 部分答案落库(真实 HTTP + fetch abort)
- `apps/api/test/askRoute.abortPersist.test.ts` — ask 路由 SSE 断连 → 部分答案落库(mock llmService 流)

**Modify:**
- `apps/api/src/routes/agent.ts` — `partialAnswer` 累积(sendEvent 加 `answer_delta` 分支)+ 落库条件改为"有内容或已中止"
- `apps/api/src/routes/ask.ts` — 新增 `persistAbortedTurn` helper + 三个 SSE 中止出口调用(L480 前置检查点 / L603 复杂路径 / L699 简单路径)
- `apps/web/src/views/AnswerView.vue` — 接线 useStreamSession;切换/新建/删除/挂载不再 abort;模板:中止+部分答案展示、输入区门控与提示、侧栏生成中指示点
- `apps/web/src/views/AnswerView.styles.css` — 侧栏生成中指示点样式

**执行顺序:** Task 1→2(后端 B,互相独立、可先验收)→ 3→6(前端 A)→ 7 回归 → 8 活体验收。B 先行是刻意的:A 落地前,现状"切会话即中断"仍在,B 已能兜住空白轮。

---

### Task 0: 提交计划文档

**Files:**
- Create: `docs/superpowers/plans/2026-08-07-streaming-survive-conversation-switch.md`(本文件)

- [ ] **Step 1: 提交(注意 docs/ 在 .gitignore 里,必须 -f)**

```bash
git add -f docs/superpowers/plans/2026-08-07-streaming-survive-conversation-switch.md
git commit -m "docs: streaming 切会话不中断 + 中止落库实现计划"
```

---

### Task 1: B·agent 路由——中止时落库部分答案

**Files:**
- Modify: `apps/api/src/routes/agent.ts:102-105`(累积器)、`:118-147`(sendEvent)、`:194-213`(落库块)
- Test: `apps/api/test/agentRoute.abortPersist.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/agentRoute.abortPersist.test.ts`:

```typescript
/**
 * /api/agent/ask 中止落库测试(切会话中断修复·方案 B):
 * 客户端 SSE 中途断开 → 路由 abort 循环后,把已流出的部分答案 + meta.aborted 落库,
 * 会话里不再留下"只有提问没有回答"的空白孤儿轮。
 * agentLoop mock 成"发一帧 delta 后等 abort"的剧本;app.inject 无法模拟中途断开,
 * 用 app.listen + 真实 fetch abort 触发路由侧 reply.raw 'close'。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

const TMP_DB = path.join(os.tmpdir(), `aiops-agentabort-test-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;

const PARTIAL = '结论:登录入口在 ';

vi.mock('../src/agent/index.js', () => ({
  agentLoop: vi.fn(async ({ onEvent, signal }: { onEvent: (e: unknown) => void; signal?: AbortSignal }) => {
    onEvent({ type: 'thinking', data: { thought: '先看入口' } });
    onEvent({ type: 'answer_delta', data: { delta: PARTIAL } });
    // 卡住直到客户端断连触发路由侧 abort——模拟"答案只流出一半"
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }),
}));

type Store = typeof import('../src/db/conversationStore.js');
let store: Store;
let app: FastifyInstance;
let baseUrl: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // 选择性离线桩:放行对本测试服务器的请求,其余(embedding/Langfuse)一律快速失败
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('http://127.0.0.1')) return realFetch(input, init);
    return Promise.reject(new TypeError('offline: fetch disabled in agent abort test'));
  }) as typeof fetch);

  const context = await import('../src/context.js');
  context.setGraphStore({} as never);

  const { registerAgent } = await import('../src/routes/agent.js');
  store = await import('../src/db/conversationStore.js');

  app = Fastify({ logger: false });
  registerAgent(app);
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

/** 轮询直到 probe 有值:断连后的落库发生在连接关闭之后,只能等 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('/api/agent/ask · 中止落库', () => {
  it('SSE 中途断连:部分答案 + meta.aborted 落库,无空白孤儿轮', async () => {
    const ctl = new AbortController();
    const resp = await fetch(`${baseUrl}/api/agent/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '登录在哪?' }),
      signal: ctl.signal,
    });
    expect(resp.status).toBe(200);

    // 读到 conversation 帧拿会话 id;读到 answer_delta 后立刻断开
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let convId = '';
    let buffer = '';
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const evt = JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> };
        if (evt.type === 'conversation') convId = evt.data.conversationId as string;
        if (evt.type === 'answer_delta') break outer;
      }
    }
    ctl.abort();
    expect(convId).toBeTruthy();

    const assistant = await waitFor(() => store.getMessages(convId).find((m) => m.role === 'assistant'));
    expect(assistant.content).toBe(PARTIAL);
    expect(assistant.meta?.aborted).toBe(true);
    // 中止前的思考轨迹照常保留
    expect(Array.isArray(assistant.meta?.steps)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aiops/api test agentRoute.abortPersist.test.ts
```

预期: FAIL — `waitFor 超时`(现状中止后 assistant 消息不落库)。

- [ ] **Step 3: 实现 agent.ts 三处修改**

3a. `finalAnswer` 声明处(约 L104)加累积器:

```typescript
    let finalAnswer = '';
    // 中止落库(切会话中断修复):累积已流出的 answer_delta,中止时以部分答案落库
    let partialAnswer = '';
```

3b. `sendEvent` 里 `tool_result` 分支后加(约 L126):

```typescript
      } else if (event.type === 'answer_delta') {
        partialAnswer += event.data.delta ?? '';
      } else if (event.type === 'reflecting') {
```

3c. 落库块(L196-211 的 `if (convId && finalAnswer) {...}`)整体替换为:

```typescript
      let memoryJob: ReturnType<typeof usageTracker.registerBackground> | null = null;
      let assistantMessageId: string | null = null;
      const clientAborted = abortCtl.signal.aborted;
      // 中止也落库(切会话中断修复):部分答案 + aborted 标记入库,切回/刷新不再出现
      // "只有提问没有回答"的空白孤儿轮;完全没流出内容时落空串,前端靠 meta.aborted 显示"已中止"
      const persistContent = finalAnswer || partialAnswer;
      if (convId && (persistContent || clientAborted)) {
        try {
          assistantMessageId = appendMessage(convId, {
            role: 'assistant',
            content: persistContent,
            mode: 'agent',
            meta: {
              followUp: finalFollowUp,
              steps,
              ...(planSteps ? { planSteps } : {}),
              ...(clientAborted ? { aborted: true } : {}),
            },
          }).id;
        } catch (err) {
          app.log.error(`对话持久化(回答)失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        // 中止后不再登记新的回答后任务(设计文档 §6.2);记忆抽取仍要求完整答案
        if (!clientAborted && finalAnswer) memoryJob = usageTracker.registerBackground('background.memory_extract');
      }

      const executionStatus = clientAborted ? 'aborted' : finalAnswer ? 'completed' : 'failed';
```

(原 L213 的 `const executionStatus = abortCtl.signal.aborted ? ...` 由上面最后一行取代,判定值改用同一次快照 `clientAborted`,避免落库与状态判定间信号翻转导致口径不一。其余代码——`usageTracker.finish`、`setAssistantMessageId`、`updateMessageMeta`、bufferedDone、后台任务启动——一律不动;中止轮的成本汇总会经由既有 `if (assistantMessageId)` 分支自动写进 meta。)

- [ ] **Step 4: 跑测试确认通过 + 既有 agent 测试不回归**

```bash
pnpm --filter @aiops/api test agentRoute.abortPersist.test.ts agentRoute.plan.test.ts agentLoop.abort.test.ts agentEvidence.test.ts
```

预期: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agent.ts apps/api/test/agentRoute.abortPersist.test.ts
git commit -m "feat(api): agent 中止时落库部分答案与 aborted 标记(切会话中断修复 B)"
```

---

### Task 2: B·ask 路由——三个 SSE 中止出口落库

**Files:**
- Modify: `apps/api/src/routes/ask.ts`(helper 加在 finalizeResponse 定义后约 L278;三个出口 L480/L603/L699)
- Test: `apps/api/test/askRoute.abortPersist.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/api/test/askRoute.abortPersist.test.ts`。范式:fixture graph(`./eval/harness.js` 的 `loadFixtureGraph`)+ 选择性离线 fetch 桩 + **partial mock llmService**(流式调用发一帧 delta 后等 abort,返回 `{text, aborted:true}`——与真实实现的中止契约一致)。无论问题被路由进复杂路径(L603 出口)还是简单路径(L699 出口),都必须落库,测试对路由选择不敏感:

```typescript
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
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aiops/api test askRoute.abortPersist.test.ts
```

预期: FAIL — `waitFor 超时`。

- [ ] **Step 3: 实现 ask.ts——helper + 三个出口**

3a. `finalizeResponse` 的收尾 `}` 之后(约 L278,同一作用域内,`convId`/`usageTracker` 均可见)新增:

```typescript
      // 中止落库(切会话中断修复·方案 B):SSE 客户端断开/点停止时,把已流出的部分答案
      // 连同 aborted 标记写库——否则会话里只剩孤儿 user 消息,切回/刷新是一片空白。
      // 与 finalizeResponse 互斥:三个中止出口落库后 return undefined,不会再走 finalizeResponse。
      const persistAbortedTurn = (partial: string): void => {
        if (!convId) return
        try {
          const msg = appendMessage(convId, {
            role: 'assistant',
            content: partial,
            mode: 'rag',
            meta: { aborted: true },
          })
          if (usageTracker) {
            // finish 幂等:这里首个调用生效,handler finally 里的再调是 no-op
            const summary = usageTracker.finish('aborted')
            setAssistantMessageId(usageTracker.turnId, msg.id)
            updateMessageMeta(msg.id, { tokenUsageSummary: summary })
          }
        } catch (err) {
          app.log.error(`对话持久化(中止部分答案)失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
```

3b. 出口一:答案生成前的中止检查点(L480-484)加一行:

```typescript
      if (abortCtl.signal.aborted) {
        app.log.info('[ask] 客户端已断开，中止管线（答案生成前）')
        trace?.error(new Error('client_cancelled'))
        // SSE 且已建会话:落一条空内容的中止标记,避免空白孤儿轮
        // (非 SSE 走到这里同样直接 return,不落库——维持现状,MCP 端有自己的超时语义)
        if (sse) persistAbortedTurn('')
        return undefined
      }
```

3c. 出口二:复杂路径流式中止(L603-608):

```typescript
          if (streamed?.aborted) {
            // 用户中断:落库部分答案后收尾,不继续管线
            trace?.error(new Error('client_cancelled'))
            persistAbortedTurn(streamed.text)
            reply.raw.end()
            return undefined
          }
```

3d. 出口三:简单路径中止(L699-704;`composeAnswerWithLlm` 中止时返回已累积文本,`answer` 即部分答案):

```typescript
        if (sse && abortCtl.signal.aborted) {
          // 用户中断:落库部分答案后收尾(composeAnswerWithLlm 中止时返回已累积文本)
          trace?.error(new Error('client_cancelled'))
          persistAbortedTurn(answer)
          reply.raw.end()
          return undefined
        }
```

- [ ] **Step 4: 跑测试确认通过 + 既有 ask 测试不回归**

```bash
pnpm --filter @aiops/api test askRoute.abortPersist.test.ts askRoute.persistence.test.ts askRoute.usage.test.ts askRoute.entry.test.ts askRoute.injection.test.ts streamNotAttempted.test.ts
```

预期: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/ask.ts apps/api/test/askRoute.abortPersist.test.ts
git commit -m "feat(api): ask SSE 中止出口落库部分答案(切会话中断修复 B)"
```

---

### Task 3: A·useStreamSession composable

**Files:**
- Create: `apps/web/src/composables/useStreamSession.ts`
- Test: `apps/web/tests/useStreamSession.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/useStreamSession.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useStreamSession } from '@/composables/useStreamSession';
import type { ConversationTurn } from '@/composables/useConversation';

const { session, nextTempKey, beginStream, attachConversationId, endStream } = useStreamSession();

function makeTurns(): ConversationTurn[] {
  return [];
}

beforeEach(() => endStream());

describe('useStreamSession · 流会话单例', () => {
  it('begin 后可读,end 后清空', () => {
    beginStream({ key: 'c1', conversationId: 'c1', turns: makeTurns(), ctrl: new AbortController() });
    expect(session.value?.key).toBe('c1');
    endStream();
    expect(session.value).toBeNull();
  });

  it('nextTempKey 单调递增且带 pending: 前缀(不与真实会话 id 空间重叠)', () => {
    const a = nextTempKey();
    const b = nextTempKey();
    expect(a).toMatch(/^pending:\d+$/);
    expect(a).not.toBe(b);
  });

  it('attachConversationId:临时 key 重挂为真实 id,返回旧 key(调用方据此判断视图归属)', () => {
    const temp = nextTempKey();
    beginStream({ key: temp, conversationId: null, turns: makeTurns(), ctrl: new AbortController() });
    const prev = attachConversationId('conv-1');
    expect(prev).toBe(temp);
    expect(session.value?.key).toBe('conv-1');
    expect(session.value?.conversationId).toBe('conv-1');
  });

  it('attachConversationId:key 已是真实 id 时幂等', () => {
    beginStream({ key: 'conv-1', conversationId: 'conv-1', turns: makeTurns(), ctrl: new AbortController() });
    expect(attachConversationId('conv-1')).toBe('conv-1');
    expect(session.value?.key).toBe('conv-1');
  });

  it('attachConversationId:无活动流时返回 null 不抛错', () => {
    expect(attachConversationId('conv-x')).toBeNull();
  });

  it('turns 按引用持有:外部 push 对 session 可见(切回整组还原的前提)', () => {
    const turns = makeTurns();
    beginStream({ key: 'c1', conversationId: 'c1', turns, ctrl: new AbortController() });
    turns.push({ question: 'q', answer: '', renderedAnswer: '', followUp: [], loading: true, error: '', elapsed: 0 });
    expect(session.value?.turns.length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aiops/web test:unit tests/useStreamSession.test.ts
```

预期: FAIL — 模块不存在。

- [ ] **Step 3: 实现 composable**

创建 `apps/web/src/composables/useStreamSession.ts`:

```typescript
import { ref } from 'vue';
import type { ConversationTurn } from './useConversation';

/**
 * 流会话单例(切会话中断修复·方案 A):
 * 把"正在 streaming 的一轮问答"从 AnswerView 的 history(视图投影)里拆出来独立持有——
 * 切换会话只换投影,后台的 SSE reader 继续往本会话的 turns 里写,切回时整组还原。
 * 模块级单例:全局同一时刻最多一条流(与输入框单流门控一致),路由离开再回也能接上。
 */
export interface StreamSession {
  /** 流所属会话的 key:已有会话=真实会话 id;新会话拿到 id 前=临时 key(pending:N) */
  key: string;
  /** 后端回带的真实会话 id(agent 的 conversation 事件 / rag 的 done 帧后填充) */
  conversationId: string | null;
  /** 该会话完整 turns 数组的引用——流式 turn 是最后一个元素,切回时直接整组还原 */
  turns: ConversationTurn[];
  /** 中止句柄:只有显式停止/删会话/切项目才调用,切会话不再中止 */
  ctrl: AbortController;
}

const session = ref<StreamSession | null>(null);

let tempKeySeq = 0;
/** 新会话(尚无后端 id)的临时视图 key;真实会话 id 是 UUID,前缀空间不重叠 */
function nextTempKey(): string {
  tempKeySeq += 1;
  return `pending:${tempKeySeq}`;
}

/** 开始一条流。调用方保证同一时刻只有一条(输入框已按 streamRunning 门控)。 */
function beginStream(s: StreamSession): void {
  session.value = s;
}

/**
 * 后端回带会话 id:填充 conversationId 并把 key 重挂为真实 id(侧栏点击/切回按 key 匹配)。
 * 返回重挂前的旧 key,供调用方判断"用户是否仍停留在这条流的视图"——
 * 归属判断必须用旧 key:重挂后新 key 永远不等于还停留在临时 key 上的视图。
 */
function attachConversationId(id: string): string | null {
  const s = session.value;
  if (!s) return null;
  const prevKey = s.key;
  s.conversationId = id;
  s.key = id;
  return prevKey;
}

/** 流结束(done/error/abort 的 finally):清空单例。 */
function endStream(): void {
  session.value = null;
}

export function useStreamSession() {
  return { session, nextTempKey, beginStream, attachConversationId, endStream };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @aiops/web test:unit tests/useStreamSession.test.ts
```

预期: PASS(6 个用例)。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/composables/useStreamSession.ts apps/web/tests/useStreamSession.test.ts
git commit -m "feat(web): useStreamSession 流会话单例(切会话中断修复 A)"
```

---

### Task 4: A·AnswerView 接线——流生命周期与门控

组件接线无单测(node 环境不 mount 组件),以 `vue-tsc` typecheck + Task 8 活体验收兜底。

**Files:**
- Modify: `apps/web/src/views/AnswerView.vue`(script 部分)

- [ ] **Step 1: 替换全局 loading/abort 状态**

删除 L420-426 的 `isAnyLoading`、`currentAbortController`、旧 `handleAbort`,替换为:

```typescript
const { session: streamSession, nextTempKey, beginStream, attachConversationId, endStream } = useStreamSession()

// 当前视图 key:查看已落库会话=会话 id;新会话(未落库)=null,首问时铸临时 key
const currentViewKey = ref<string | null>(activeConversationId.value)
// 全局是否有流在跑(单流门控:输入框停用)/当前视图是否就是那条流(停止按钮、自动滚动)
const streamRunning = computed(() => streamSession.value !== null)
const viewOwnsStream = computed(
  () => streamSession.value !== null && streamSession.value.key === currentViewKey.value,
)

function handleAbort() {
  streamSession.value?.ctrl.abort()
}
```

import 区加:`import { useStreamSession } from '@/composables/useStreamSession'`。

- [ ] **Step 2: 两个 fetch 函数登记流会话**

`fetchAnswer`(L628-632)与 `fetchAgentAnswer`(L744-748)同款改法,`const ctrl = new AbortController()` 之后、原 `currentAbortController.value = ctrl` 位置改为:

```typescript
  const ctrl = new AbortController()
  // 流会话登记:视图无会话 id(新会话首问)时铸临时 key,后端回带 id 后重挂
  if (!currentViewKey.value) currentViewKey.value = nextTempKey()
  beginStream({ key: currentViewKey.value, conversationId: activeConversationId.value, turns: history.value, ctrl })
```

(注意 `beginStream` 必须在 `history.value.push(turn)` 之后——`turns` 捕获的是包含本轮 turn 的数组引用。)

- [ ] **Step 3: 会话 id 回带统一走归属检查**

新增函数(放 `syncConversationList` 附近):

```typescript
// 后端回带会话 id:重挂流会话 key;仅当用户仍停留在这条流的视图时才落活动会话——
// 无条件 setActiveConversation 会在用户已切走时把侧栏高亮/localStorage 强行拉回(A 之前的隐性 bug)
function onStreamConversationId(id: string): void {
  const prevKey = attachConversationId(id)
  if (prevKey !== null && prevKey === currentViewKey.value) {
    currentViewKey.value = id
    setActiveConversation(id)
  }
  syncConversationList(id)
}
```

替换两处调用点:
- `fetchAgentAnswer` 的 `case 'conversation'`(L797-802):`if (event.data.conversationId) onStreamConversationId(event.data.conversationId as string)`
- `fetchAnswer` 的 `case 'done'` 里 L692-695 的 `setActiveConversation + syncConversationList` 两行 → `onStreamConversationId(event.data.conversationId as string)`

- [ ] **Step 4: 滚动门控 + finally 收尾**

两个 fetch 函数中,事件循环内的 `await scrollToBottom()`(rag L703、agent L848)改为:

```typescript
          if (viewOwnsStream.value) await scrollToBottom()
```

两个 finally 块(rag L715-723、agent L860-868)统一改为:

```typescript
  } finally {
    clearInterval(elapsedTimer)
    turn.loading = false
    const owned = viewOwnsStream.value
    endStream()
    if (owned) await scrollToBottom()
    // 一轮结束后同步会话列表(标题/排序)与记忆(问答可能沉淀新记忆)
    void refreshConversations()
    void refreshMemories()
  }
```

- [ ] **Step 5: handleAsk / askFollowUp 门控改为 streamRunning**

```typescript
function handleAsk() {
  const q = newQuestion.value.trim()
  if (!q || streamRunning.value) return
  ...
}
function askFollowUp(q: string) {
  if (streamRunning.value) return
  ...
}
```

- [ ] **Step 6: typecheck(此时 `isAnyLoading` 引用会报错——属预期:模板 + `switchConversation`/`startNewConversation` 两个函数要到 Task 5/6 才改写。本步只确认没有 isAnyLoading 之外的类型错误,不要提前动 Task 5 的代码)**

```bash
pnpm --filter @aiops/web typecheck
```

预期: 仅剩 `isAnyLoading` 相关错误(模板与上述两函数)。若还有其他错误,先修复。

- [ ] **Step 7: Commit(与 Task 5/6 合并提交亦可,若单独提交需模板同步最小改动保证可编译)**

建议本 Task 不单独提交,与 Task 5、6 一起在 Task 6 末尾提交(模板与 script 强耦合,拆开必然出现中间态编译不过)。

---

### Task 5: A·AnswerView 接线——切换/新建/删除/挂载不再中止

**Files:**
- Modify: `apps/web/src/views/AnswerView.vue`(script 部分)

- [ ] **Step 1: switchConversation 重写(核心:去掉 handleAbort,活流优先内存还原)**

```typescript
// 切换会话:活流会话直接还原内存 turns;其余 GET 该会话消息 → messagesToTurns 还原
async function switchConversation(id: string) {
  if (id === currentViewKey.value) {
    if (window.innerWidth <= 768) sidebarCollapsed.value = true
    return
  }
  // 切到正在 streaming 的会话:还原内存 turns(assistant 还没落库,GET 会缺最后一轮),不打请求
  const live = streamSession.value
  if (live && live.key === id) {
    history.value = live.turns
    currentViewKey.value = id
    setActiveConversation(id)
    if (window.innerWidth <= 768) sidebarCollapsed.value = true
    await scrollToBottom()
    return
  }
  try {
    const { turns } = await loadConversation(id, renderMarkdown)
    history.value = turns.map(t => reactive(t))
    resumeUsagePolling()
    currentViewKey.value = id
    setActiveConversation(id)
    if (window.innerWidth <= 768) sidebarCollapsed.value = true
    await scrollToBottom()
  } catch {
    ElMessage.error('加载会话失败')
  }
}
```

- [ ] **Step 2: startNewConversation 不再中止流**

```typescript
// 新建会话:清空视图起一条干净会话。后台流(如有)继续跑完并由后端落库,完成后可从侧栏切回
function startNewConversation() {
  clearActiveConversation()
  history.value = []
  currentViewKey.value = null
  if (window.innerWidth <= 768) sidebarCollapsed.value = true
}
```

- [ ] **Step 3: removeConversation 补流会话防护 + currentViewKey 清理**

```typescript
async function removeConversation(c: Conversation) {
  try {
    // 删除正在 streaming 的会话:先中止流(继续为已删除的会话生成没有意义;
    // 服务端中止落库会因会话已删而失败,只留 error 日志,可接受)
    if (streamSession.value?.key === c.id) streamSession.value.ctrl.abort()
    await deleteConversation(c.id)
    if (c.id === activeConversationId.value || c.id === currentViewKey.value) {
      clearActiveConversation()
      history.value = []
      currentViewKey.value = null
    }
    await refreshConversations()
  } catch {
    ElMessage.error('删除会话失败')
  }
}
```

- [ ] **Step 4: 切项目 watch 补显式中止**

```typescript
watch(currentRepo, (newRepo, oldRepo) => {
  if (oldRepo && newRepo && newRepo !== oldRepo) {
    // 旧项目的流没有归宿:显式中止(B 会落库部分答案),避免它继续往旧项目会话里写
    streamSession.value?.ctrl.abort()
    clearActiveConversation()
    history.value = []
    currentViewKey.value = null
    void refreshConversations()
    void refreshMemories()
  }
})
```

- [ ] **Step 5: onMounted 恢复路径——活流优先 + currentViewKey 初始化**

pendingQuestion 分支(L933-936)加一行 `currentViewKey.value = null`(在 `history.value = []` 后);else 分支(L937-946)改为:

```typescript
  } else {
    // 路由离开再回来且流还在跑:优先还原内存活流(库里还没有 assistant 消息)
    const live = streamSession.value
    if (live && live.key === activeConversationId.value) {
      history.value = live.turns
      currentViewKey.value = live.key
    } else {
      // 刷新/重进:恢复活动会话,归属项目不一致则视为无效、起空会话
      const { conversation, turns } = await restoreConversation(renderMarkdown)
      if (conversation && conversation.projectId === currentProjectId.value) {
        history.value = turns.map(t => reactive(t))
        resumeUsagePolling()
      } else if (conversation) {
        clearActiveConversation()
      }
      currentViewKey.value = activeConversationId.value
    }
  }
```

已知边界(不处理,记录在案):新会话拿到 id 前(临时 key 阶段)路由离开再回来,活流 key 是 `pending:N` 而 `activeConversationId` 为 null,匹配不上 → 视图起空会话,流在后台跑完落库,侧栏刷新后可切回看到完整答案。多标签页共享同一会话的并发流也不在本期范围。

- [ ] **Step 6: 不单独提交,进 Task 6 合并提交**

---

### Task 6: A+B·模板——中止+部分答案展示、输入区、侧栏指示点

**Files:**
- Modify: `apps/web/src/views/AnswerView.vue`(template 部分)
- Modify: `apps/web/src/views/AnswerView.styles.css`

- [ ] **Step 1: 回答区状态分支重排(中止轮也展示部分答案)**

L252-281 的四分支(`loading / aborted / error / answer`)改为三分支 + 中止徽标后置:

```html
                  <!-- 加载状态 -->
                  <div v-if="turn.loading" class="loading-indicator">
                    <div class="typing-dots"><span></span><span></span><span></span></div>
                    <span class="loading-text">
                      {{ turn.steps && turn.steps.length > 0 ? 'Agent 正在分析代码...' : '正在阅读代码并分析...' }}
                    </span>
                    <span v-if="turn.elapsed > 0" class="loading-elapsed">{{ turn.elapsed }}s</span>
                  </div>

                  <!-- 错误状态 -->
                  <div v-else-if="turn.error" class="error-msg">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                    {{ turn.error }}
                  </div>

                  <!-- 正常/中止:有部分答案照常渲染,中止轮追加徽标(B:部分答案不再被"已中止"吞掉) -->
                  <template v-else>
                    <div v-if="turn.renderedAnswer" class="answer-content markdown-body" v-html="turn.renderedAnswer"></div>
                    <div v-if="turn.aborted" class="aborted-msg">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                      </svg>
                      <span>{{ turn.answer ? '已中止——以上为中止前的部分回答' : '已中止' }}</span>
                    </div>
                  </template>
```

- [ ] **Step 2: 输入区门控与提示**

L320-339 的 input/按钮改为:

```html
          <div class="input-box">
            <input
              ref="inputRef"
              v-model="newQuestion"
              :placeholder="streamRunning && !viewOwnsStream ? '另一会话正在生成中,完成后可继续提问' : '继续提问...'"
              @keyup.enter="handleAsk"
              :disabled="streamRunning"
            />
            <button v-if="viewOwnsStream" class="stop-btn" @click="handleAbort" title="中止">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
            <button v-else class="send-btn" @click="handleAsk" :disabled="!newQuestion.trim() || streamRunning">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            </button>
          </div>
```

(停止按钮只在"当前视图就是那条流"时出现;在别的会话里看到的是禁用的发送按钮 + 占位提示。)

- [ ] **Step 3: 侧栏高亮改跟视图 + 生成中指示点**

L57 的 `:class="{ active: c.id === activeConversationId }"` 改为 `:class="{ active: c.id === currentViewKey }"`;
L61 `conv-title` 行后加指示点:

```html
                  <span class="conv-title">{{ conversationLabel(c) }}</span>
                  <span
                    v-if="streamSession && streamSession.key === c.id"
                    class="conv-streaming-dot"
                    title="生成中"
                  />
```

`AnswerView.styles.css` 末尾追加:

```css
/* 侧栏:正在 streaming 的会话指示点(切会话中断修复 A) */
.conv-streaming-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-primary, #409eff);
  display: inline-block;
  margin-left: 6px;
  flex-shrink: 0;
  animation: conv-streaming-pulse 1.2s ease-in-out infinite;
}
@keyframes conv-streaming-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
```

- [ ] **Step 4: typecheck + 全量 web 单测**

```bash
pnpm --filter @aiops/web typecheck && pnpm --filter @aiops/web test:unit
```

预期: 全绿(模板里 `isAnyLoading` 引用已全部替换)。

- [ ] **Step 5: Commit(Task 4+5+6 合并)**

```bash
git add apps/web/src/views/AnswerView.vue apps/web/src/views/AnswerView.styles.css
git commit -m "feat(web): 切会话不再中断 streaming——流会话与视图解耦接线(切会话中断修复 A)"
```

---

### Task 7: 双包全量回归

- [ ] **Step 1: api 全量**

```bash
pnpm --filter @aiops/api typecheck && pnpm --filter @aiops/api test
```

预期: 全绿。重点盯 `askRoute.usage.test.ts` / `usageSecondWriter.test.ts`(persistAbortedTurn 里动了 finish/setAssistantMessageId 的调用时序)。

- [ ] **Step 2: web 全量**

```bash
pnpm --filter @aiops/web typecheck && pnpm --filter @aiops/web test:unit
```

预期: 全绿。

- [ ] **Step 3: 有失败则修复后重跑,直到全绿再进 Task 8**

---

### Task 8: 活体验收(浏览器手测清单)

前置:先探测 4200/4201 是否已有栈在跑(用户常开着 dev,重复启动会 EADDRINUSE)——`lsof -i :4200 -i :4201` 有进程就直接用,没有才 `pnpm dev`。登录密码走 `AUTH_PASSWORD`(读 `.env` 用 sed,该文件 grep 不可读)。

- [ ] **A-1 核心场景:** Agent 模式发起新对话 → streaming 中点侧栏另一历史会话 → 能看到历史内容、无中断迹象 → 切回 → 打字机继续、思考步骤在涨 → 跑完出完整答案 + 成本摘要。
- [ ] **A-2 侧栏指示:** streaming 中切走后,侧栏该会话条目出现脉冲小点;输入框禁用且占位提示"另一会话正在生成中";无停止按钮(在别的会话视图里)。
- [ ] **A-3 新建会话:** streaming 中点"新建会话" → 视图清空、流后台继续;完成后从侧栏切回能看到完整答案。
- [ ] **B-1 显式停止:** 回到流所在会话点停止按钮 → 部分答案保留 + "已中止——以上为中止前的部分回答"徽标;刷新页面后该轮仍显示部分答案 + 徽标(落库还原)。
- [ ] **B-2 刷新中断:** streaming 中直接刷新页面 → 恢复后该轮显示部分答案(或空内容时仅"已中止")而非空白。
- [ ] **B-3 普通模式抽查:** RAG 模式验证两条——(a) 在**已有会话**里追问后切走再切回(A-1 同款;注意 rag 新会话的 id 在 done 帧才回带,streaming 期间侧栏还没有它的条目,新会话场景只能等流完成后从侧栏找回,这属已知边界不是 bug);(b) 显式停止 → 部分答案 + 已中止徽标(B-1 同款)。
- [ ] **回归抽查:** 正常问答一轮(不切换)行为与改前一致;会话重命名/删除正常;删除正在 streaming 的会话 → 流停、视图清空、无报错弹窗。

验收全过后按仓库惯例收尾(评审清单/finishing-a-development-branch)。

---

## 明确不做(YAGNI,防蔓延)

- 多条流并发(每会话一条):输入框保持全局单流门控,提示语引导等待。
- 断连后服务端继续跑完(方案 C):成本语义变化大,等 A+B 上线后再评估。
- 多标签页共享流、临时 key 阶段路由离开的活流找回:记录为已知边界。
- messagesToTurns 对"孤儿 user + 无 aborted 标记"(服务端崩溃残留)的推断式补标:宁缺毋滥。
