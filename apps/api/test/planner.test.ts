/**
 * P1-C 规划器单测（此前 planner 零单测——验收闭环的一环）。
 * shouldPlan 是纯启发式，直接判定；generatePlan mock 掉 LLM，验证解析/降级纪律。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/agent/llmWithTools.js', () => ({
  callChatCompletionWithTools: vi.fn(),
}));

import { callChatCompletionWithTools } from '../src/agent/llmWithTools.js';
import { shouldPlan, generatePlan, renderPlanForPrompt } from '../src/agent/planner.js';

const mockLlm = callChatCompletionWithTools as unknown as ReturnType<typeof vi.fn>;
const llm = { provider: 'deepseek' as const, model: 'm', baseUrl: 'http://x', apiKey: 'k', timeoutMs: 5000 };
const reply = (content: string | null) => ({ content, toolCalls: null, reasoningContent: null });

beforeEach(() => mockLlm.mockReset());

describe('shouldPlan · 长任务判定（纯启发式）', () => {
  it('信号词命中即规划（短问题也算）', () => {
    expect(shouldPlan('梳理下单链路')).toBe(true);
    expect(shouldPlan('帮我排查这个报错')).toBe(true);
    expect(shouldPlan('重构这块逻辑')).toBe(true);
  });

  it('无信号词的短定位问题：不规划（省一次 LLM 调用）', () => {
    expect(shouldPlan('登录在哪个文件？')).toBe(false);
    expect(shouldPlan('这个按钮点了会怎样')).toBe(false);
  });

  it('字数阈值：≥60 字的复合诉求即使无信号词也规划', () => {
    expect(shouldPlan('短问题')).toBe(false);
    expect(shouldPlan('这个页面'.repeat(16))).toBe(true); // 64 字
  });

  it('PLANNER_DISABLE=1：整体关规划器（on/off 对照实验开关）', () => {
    const prev = process.env.PLANNER_DISABLE;
    process.env.PLANNER_DISABLE = '1';
    try {
      expect(shouldPlan('梳理下单链路')).toBe(false); // 本会触发的用例也被强制关闭
    } finally {
      if (prev === undefined) delete process.env.PLANNER_DISABLE;
      else process.env.PLANNER_DISABLE = prev;
    }
  });
});

describe('generatePlan · 解析与降级纪律（mock LLM）', () => {
  it('合法 JSON：抽出 steps 数组', async () => {
    mockLlm.mockResolvedValueOnce(reply('{"steps":["定位页面组件","追踪提交方法","查接口调用"]}'));
    expect(await generatePlan('梳理链路', llm)).toEqual(['定位页面组件', '追踪提交方法', '查接口调用']);
  });

  it('容忍 JSON 前后杂文（取首个 { 到末个 }）', async () => {
    mockLlm.mockResolvedValueOnce(reply('好的，计划如下：\n{"steps":["步骤A","步骤B"]}\n以上。'));
    expect(await generatePlan('梳理链路', llm)).toEqual(['步骤A', '步骤B']);
  });

  it('上限 7 步：超出截断', async () => {
    const steps = Array.from({ length: 10 }, (_, i) => `步骤${i + 1}`);
    mockLlm.mockResolvedValueOnce(reply(JSON.stringify({ steps })));
    const out = await generatePlan('梳理链路', llm);
    expect(out).toHaveLength(7);
    expect(out![6]).toBe('步骤7');
  });

  it('下限 2 步：不足 2 步降级为 null（一步计划无价值）', async () => {
    mockLlm.mockResolvedValueOnce(reply('{"steps":["就一步"]}'));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });

  it('过滤空白步：清洗后仍 <2 步 → null', async () => {
    mockLlm.mockResolvedValueOnce(reply('{"steps":["有效步骤"," ","",null]}'));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });

  it('非 JSON / 无花括号 → null（增强不是闸门）', async () => {
    mockLlm.mockResolvedValueOnce(reply('抱歉我无法规划'));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });

  it('steps 非数组 → null', async () => {
    mockLlm.mockResolvedValueOnce(reply('{"steps":"一二三"}'));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });

  it('LLM 抛异常（超时等）→ 静默 null', async () => {
    mockLlm.mockRejectedValueOnce(new Error('timeout'));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });

  it('LLM 返回 null content → null', async () => {
    mockLlm.mockResolvedValueOnce(reply(null));
    expect(await generatePlan('梳理链路', llm)).toBeNull();
  });
});

describe('renderPlanForPrompt · 计划注入片段', () => {
  it('带序号列出步骤 + 收尾约束', () => {
    const out = renderPlanForPrompt(['定位组件', '追踪调用链']);
    expect(out).toContain('1. 定位组件');
    expect(out).toContain('2. 追踪调用链');
    expect(out).toContain('立即停止调用工具');
  });
});
