/**
 * agent 循环中止语义单测（P1-D 遗留④的自动化背书，此前流式/中断路径零测试）。
 * mock 掉 LLM 与工具执行：验证的是循环自身的中止纪律，不是网络行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent } from '@aiops/shared-types';

vi.mock('../src/agent/llmWithTools.js', () => ({
  callChatCompletionWithTools: vi.fn(),
}));
vi.mock('../src/agent/tools.js', () => ({
  getOpenAITools: () => [],
  executeTool: vi.fn(async () => '工具结果'),
}));

import { callChatCompletionWithTools } from '../src/agent/llmWithTools.js';
import { agentLoop } from '../src/agent/agentLoop.js';

const mockLlm = callChatCompletionWithTools as unknown as ReturnType<typeof vi.fn>;

const baseOpts = {
  graphStore: null,
  repoPath: '/tmp/nowhere',
  llm: { provider: 'deepseek' as const, model: 'm', baseUrl: 'http://x', apiKey: 'k' },
};

// 问题保持短句：shouldPlan=false，不触发规划器调用，测试聚焦主循环
const QUESTION = '登录在哪？';

beforeEach(() => mockLlm.mockReset());

describe('agentLoop · 中止纪律', () => {
  it('进入前已中止：零 LLM 调用、零事件（连接已死，没有观众）', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const events: AgentEvent[] = [];
    await agentLoop({ ...baseOpts, question: QUESTION, onEvent: (e) => events.push(e), signal: ctl.signal });
    expect(mockLlm).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('轮间中止：首轮工具调用后断连 → 不再发起第二轮 LLM、不发 done/error', async () => {
    const ctl = new AbortController();
    const events: AgentEvent[] = [];
    // 首轮返回一个工具调用；工具事件产生后模拟客户端断开
    mockLlm.mockResolvedValueOnce({
      content: null,
      reasoningContent: null,
      toolCalls: [{ id: 't1', name: 'search_code', arguments: '{}' }],
    });
    await agentLoop({
      ...baseOpts,
      question: QUESTION,
      signal: ctl.signal,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'tool_result') ctl.abort();
      },
    });
    expect(mockLlm).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('中止期间 LLM 抛 AbortError：静默退出而非 error 事件', async () => {
    const ctl = new AbortController();
    const events: AgentEvent[] = [];
    mockLlm.mockImplementationOnce(async () => {
      ctl.abort(); // 调用进行中客户端断开
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await agentLoop({ ...baseOpts, question: QUESTION, onEvent: (e) => events.push(e), signal: ctl.signal });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('无中止的正常路径：文本答案 → answer_delta + done（回归护栏）', async () => {
    const events: AgentEvent[] = [];
    mockLlm.mockResolvedValueOnce({ content: '结论：在 login.ts。', reasoningContent: null, toolCalls: null });
    await agentLoop({ ...baseOpts, question: QUESTION, onEvent: (e) => events.push(e) });
    expect(mockLlm).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
