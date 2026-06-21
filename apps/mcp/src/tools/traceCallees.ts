import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatGraph } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface TraceResp { symbol: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[]; message?: string }

export const traceCallees: ToolDescriptor = {
  name: 'trace_callees',
  config: {
    description:
      '追踪某符号「调用了谁」（依赖链 / 下游）。例：看一个函数依赖哪些函数/服务。结果反映上次索引时的状态。',
    inputSchema: {
      symbol: z.string().describe('符号名（可先用 search_symbols 确认）'),
      depth: z.number().int().positive().optional().describe('追踪深度，默认 3'),
    },
  },
  handler: async (args) => {
    const { symbol, depth } = args as { symbol: string; depth?: number };
    const data = await analyzerGet<TraceResp>('/api/trace', { symbol, depth });
    if (data.message === 'SYMBOL_NOT_FOUND') {
      return text(`未找到符号 "${symbol}"。先用 search_symbols 确认名字。`);
    }
    return text(`${symbol} 调用了谁（依赖链，深度 ${data.depth}）：\n${formatGraph(data.nodes, data.edges)}`);
  },
};
