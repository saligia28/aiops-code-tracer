import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatGraph } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface WhyResp { target: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[]; message?: string }

export const traceCallers: ToolDescriptor = {
  name: 'trace_callers',
  config: {
    description:
      '追踪「谁调用了某符号」（影响面 / 上游）。例：改一个函数前看谁会受影响。结果反映上次索引时的状态。',
    inputSchema: {
      symbol: z.string().describe('符号名（可先用 search_symbols 确认）'),
      depth: z.number().int().positive().optional().describe('追踪深度，默认 3'),
    },
  },
  handler: async (args) => {
    const { symbol, depth } = args as { symbol: string; depth?: number };
    // API 端点 /api/why 的 query 参数叫 target。
    const data = await analyzerGet<WhyResp>('/api/why', { target: symbol, depth });
    if (data.message === 'SYMBOL_NOT_FOUND') {
      return text(`未找到符号 "${symbol}"。先用 search_symbols 确认名字。`);
    }
    return text(`谁调用了 ${symbol}（影响面，深度 ${data.depth}）：\n${formatGraph(data.nodes, data.edges)}`);
  },
};
