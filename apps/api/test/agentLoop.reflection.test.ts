/**
 * agent 自校验（P0-A·T1）单测 —— 反思真的跑了、只重答一次、失败不挡路、中止不触发。
 *
 * 最关键的一条是「L1 真跑了」：直接把 reflectOnAnswer 接上去而不补证据层的话，
 * 它会被 `evidence.length > 0` 守卫**静默跳过**，事件照发、日志照打，但一次核对都没做。
 * 所以这里断言 `done.citationAccuracy` 有值——它是 L1 实际执行过的唯一凭据。
 *
 * LLM 与工具执行走 mock；被核对的文件是随仓库提交的 fixture（citationAccuracy 要真读盘）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@aiops/shared-types';

vi.mock('../src/agent/llmWithTools.js', () => ({
  callChatCompletionWithTools: vi.fn(),
}));
vi.mock('../src/agent/tools.js', () => ({
  getOpenAITools: () => [],
  executeTool: vi.fn(),
}));

import { callChatCompletionWithTools } from '../src/agent/llmWithTools.js';
import { executeTool } from '../src/agent/tools.js';
import { agentLoop } from '../src/agent/agentLoop.js';

const mockLlm = callChatCompletionWithTools as unknown as ReturnType<typeof vi.fn>;
const mockTool = executeTool as unknown as ReturnType<typeof vi.fn>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, 'eval/fixture-repo');
const TARGET = 'src/api/orderVoid.ts';
const SOURCE = fs.readFileSync(path.join(REPO, TARGET), 'utf-8').split('\n');
/** 一个真实存在、且该行确有 voidOrder 标识符的行号 */
const GOOD_LINE = SOURCE.findIndex((l) => l.includes('export function voidOrder')) + 1;

/** 复刻 read_file 的真实输出格式（工具被 mock 掉了，但格式必须真） */
const READ_FILE_RESULT =
  `[${TARGET}] 共 ${SOURCE.length} 行，显示 1-${SOURCE.length}:\n` +
  SOURCE.map((l, i) => `${i + 1}: ${l}`).join('\n');

const baseOpts = {
  graphStore: null,
  repoPath: REPO,
  llm: { provider: 'deepseek' as const, model: 'm', baseUrl: 'http://x', apiKey: 'k' },
};
// 短问题 → shouldPlan=false，不引入规划器那次 LLM 调用，计数才干净
const QUESTION = '作废在哪？';

const toolCallTurn = { content: null, reasoningContent: null, toolCalls: [{ id: 't1', name: 'read_file', arguments: JSON.stringify({ filePath: TARGET }) }] };
const textTurn = (content: string) => ({ content, reasoningContent: null, toolCalls: null });

beforeEach(() => {
  mockLlm.mockReset();
  mockTool.mockReset();
  mockTool.mockResolvedValue(READ_FILE_RESULT);
});

async function run(signal?: AbortSignal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await agentLoop({ ...baseOpts, question: QUESTION, onEvent: (e) => events.push(e), signal });
  return events;
}

describe('agentLoop · 自校验（T1）', () => {
  it('引用属实 → L1 真的跑了（citationAccuracy 有值）且零额外 LLM 调用', async () => {
    mockLlm.mockResolvedValueOnce(toolCallTurn);
    mockLlm.mockResolvedValueOnce(textTurn(`结论：作废接口在 ${TARGET}:${GOOD_LINE}，函数是 voidOrder。`));

    const events = await run();
    const done = events.find((e) => e.type === 'done')!;

    // ★ 证据层没接上的话这里会是 undefined —— L1 被 evidence.length>0 静默跳过
    expect(done.data.citationAccuracy).toBe(1);
    expect(done.data.reflectionRetried).toBe(false);
    expect(events.some((e) => e.type === 'reflecting')).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(2); // 两轮循环，无重答
  });

  it('引用不实（行号越界）→ 发 reflecting 且恰好重答 1 次，done 用重答后的答案', async () => {
    mockLlm.mockResolvedValueOnce(toolCallTurn);
    mockLlm.mockResolvedValueOnce(textTurn(`结论：作废逻辑在 ${TARGET}:999。`)); // 该文件根本没有 999 行
    mockLlm.mockResolvedValueOnce(textTurn(`更正：作废接口在 ${TARGET}:${GOOD_LINE} 的 voidOrder。`));

    const events = await run();

    const reflecting = events.find((e) => e.type === 'reflecting');
    expect(reflecting, '自查未通过应发 reflecting 事件').toBeDefined();
    expect(reflecting!.data.citationAccuracy).toBe(0);

    expect(mockLlm).toHaveBeenCalledTimes(3); // 2 轮 + 1 次重答，**不允许**第二次重答
    const done = events.find((e) => e.type === 'done')!;
    expect(done.data.answer).toContain('更正');
    expect(done.data.reflectionRetried).toBe(true);

    // 用户看到的应当只有重答后的那份（重答发生在 answer_delta 之前，不存在"答案被撤回"）
    const deltas = events.filter((e) => e.type === 'answer_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].data.delta).toContain('更正');
    expect(deltas[0].data.delta).not.toContain('999');
  });

  it('重答调用失败 → 放行原答案（反思是增强不是闸门）', async () => {
    mockLlm.mockResolvedValueOnce(toolCallTurn);
    mockLlm.mockResolvedValueOnce(textTurn(`结论：作废逻辑在 ${TARGET}:999。`));
    mockLlm.mockRejectedValueOnce(new Error('LLM 挂了'));

    const events = await run();
    const done = events.find((e) => e.type === 'done');

    expect(done, '重答失败不该让用户拿不到回答').toBeDefined();
    expect(done!.data.answer).toContain('999'); // 原答案原样返回
    expect(done!.data.reflectionRetried).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('中止期间不触发反思：零 reflecting、零 done', async () => {
    const ctl = new AbortController();
    mockLlm.mockResolvedValueOnce(toolCallTurn);
    mockLlm.mockImplementationOnce(async () => {
      ctl.abort(); // 最终答案返回的同时客户端断开
      return textTurn(`结论：作废逻辑在 ${TARGET}:999。`);
    });

    const events = await run(ctl.signal);

    expect(events.some((e) => e.type === 'reflecting')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(2); // 没有第三次（重答）
  });

  it('答案没给 file:line → evidence 为空，L1 诚实标注「未跑」而非伪造满分', async () => {
    mockLlm.mockResolvedValueOnce(textTurn('结论：没有定位到相关实现，建议补充关键词。'));

    const events = await run();
    const done = events.find((e) => e.type === 'done')!;

    expect(done.data.citationAccuracy).toBeUndefined();
    expect(done.data.reflectionRetried).toBe(false);
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });
});
