import { z } from 'zod';
import type { AskResponse } from '@aiops/shared-types';
import { analyzerPost } from '../client.js';
import { formatAskResponse } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

/**
 * /api/ask 专用超时：走完整 LLM 管线（最多 3-4 次串行 LLM 调用，单次上限 60s），
 * 全局 30s 超时对它必然不够。ANALYZER_ASK_TIMEOUT_MS 可调；注意消费端（Claude Code）
 * 自己的 MCP 工具超时（MCP_TOOL_TIMEOUT）也需 ≥ 此值，否则这里调了也白调。
 */
const ASK_TIMEOUT_MS = Number(process.env.ANALYZER_ASK_TIMEOUT_MS) || 120_000;

export const explainCodeLogic: ToolDescriptor = {
  name: 'explain_code_logic',
  config: {
    description:
      '用自然语言分析当前仓库中的业务/代码逻辑，返回回答、代码证据、文档证据与图谱摘要。适合在改代码前先获取任务上下文。结果反映上次索引时的状态。注意：本工具走 LLM 分析、耗时较长（数十秒）；简单的符号定位/调用链查询请优先用 search_symbols / trace_callees / trace_callers。',
    inputSchema: {
      question: z
        .string()
        .trim()
        .min(1, 'question 不能为空')
        .describe('要分析的代码逻辑问题，例如“样衣作废按钮点击后做了什么？”。建议每次把上下文写全（写明页面/组件名），而非依赖代词。'),
      conversationId: z
        .string()
        .optional()
        .describe('可选：复用已有问答会话做多轮追问（会把对话持久化到分析服务）。不传则为无状态问答，不产生会话记录。'),
    },
  },
  handler: async (args) => {
    const { question, conversationId } = args as { question: string; conversationId?: string };
    const data = await analyzerPost<AskResponse>(
      '/api/ask',
      {
        question,
        conversationId,
        // 来源标记：无 conversationId 时服务端跳过会话落库，且恒不做记忆抽取——
        // 机器提问不淤积人类侧边栏、不污染项目记忆（review 修复）
        source: 'mcp',
      },
      { timeoutMs: ASK_TIMEOUT_MS },
    );
    return text(formatAskResponse(question, data, { requestedConversationId: conversationId }));
  },
};
