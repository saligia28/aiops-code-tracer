import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatGraph } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface SymbolResp { symbol: string; nodes: GraphNode[]; edges: GraphEdge[]; message?: string }

export const getSymbol: ToolDescriptor = {
  name: 'get_symbol',
  config: {
    description:
      '查看一个符号的详情及其「深度 1」的直接邻居（直接调用方与被调方）。快速了解某个符号是什么、跟谁直接相连。结果反映上次索引时的状态。',
    inputSchema: { name: z.string().describe('符号名') },
  },
  handler: async (args) => {
    const { name } = args as { name: string };
    const data = await analyzerGet<SymbolResp>('/api/graph/symbol', { name });
    if (data.message === 'SYMBOL_NOT_FOUND') {
      return text(`未找到符号 "${name}"。先用 search_symbols 确认名字。`);
    }
    return text(`符号 ${name}（直接邻居）：\n${formatGraph(data.nodes, data.edges)}`);
  },
};
