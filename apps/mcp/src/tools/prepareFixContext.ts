import { z } from 'zod';
import type { AskResponse } from '@aiops/shared-types';
import { analyzerPost } from '../client.js';
import { assembleAnalysisPacket } from '../analysisPacket.js';
import { formatAnalysisPacket } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

/**
 * 与 explain_code_logic 同款 ask 专用长超时：走完整 LLM 管线（最多 3-4 次串行 LLM，单次上限 60s），
 * 全局 30s 必然不够。消费端自己的 MCP 工具超时（MCP_TOOL_TIMEOUT）也需 ≥ 此值。
 */
const ASK_TIMEOUT_MS = Number(process.env.ANALYZER_ASK_TIMEOUT_MS) || 120_000;

export const prepareFixContext: ToolDescriptor = {
  name: 'prepare_fix_context',
  config: {
    description:
      '面向 bug 修复 / 需求改动的任务前置分析：给一个"要改什么"的问题，返回结构化的修改上下文——入口文件、关键流程、相关文件、接口调用、疑似修改点、验证建议与代码证据。改代码前先调它拿到"从哪改"的锚，降低"边猜边改"。注意：本工具走 LLM 分析、耗时较长（数十秒）；只需符号定位/调用链请优先用 search_symbols / trace_callers / trace_callees。无状态、不产生会话记录。结果反映上次索引时的状态。',
    inputSchema: {
      question: z
        .string()
        .trim()
        .min(1, 'question 不能为空')
        .describe('要修改/排查的问题，例如"订单作废按钮点击后做了什么？我要改作废校验逻辑"。请写全页面/组件名，别依赖代词。'),
    },
  },
  handler: async (args) => {
    const { question } = args as { question: string };
    const data = await analyzerPost<AskResponse>(
      '/api/ask',
      // 无 conversationId + source:'mcp' = 服务端无状态问答（不落库、不抽取记忆）
      { question, source: 'mcp' },
      { timeoutMs: ASK_TIMEOUT_MS },
    );
    const packet = assembleAnalysisPacket(question, data);
    return text(formatAnalysisPacket(packet));
  },
};
