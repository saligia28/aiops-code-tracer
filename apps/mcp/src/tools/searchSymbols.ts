import { z } from 'zod';
import type { GraphNode } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatSearch } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

export const searchSymbols: ToolDescriptor = {
  name: 'search_symbols',
  config: {
    description:
      '按名字搜索代码符号（函数/组件/类/方法等），返回精确文件位置。分析现有代码的第一步。结果反映上次索引时的状态。',
    inputSchema: {
      q: z.string().describe('符号名或关键词'),
      limit: z.number().int().positive().optional().describe('最多返回条数，默认 50'),
    },
  },
  handler: async (args) => {
    const { q, limit } = args as { q: string; limit?: number };
    const data = await analyzerGet<{ query: string; total: number; results: GraphNode[] }>(
      '/api/search',
      { q, limit },
    );
    return text(formatSearch(data.query, data.results, data.total));
  },
};
