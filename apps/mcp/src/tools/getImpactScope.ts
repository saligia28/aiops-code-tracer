import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatImpactScope } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface WhyResp { target: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[]; message?: string }
interface TraceResp { symbol: string; depth: number; nodes: GraphNode[]; edges: GraphEdge[]; message?: string }

export const getImpactScope: ToolDescriptor = {
  name: 'get_impact_scope',
  config: {
    description:
      '一次拿到某符号的完整影响面：上游调用方（改动会波及谁）+ 下游依赖（改动依赖什么）。改一个函数/方法前先调它评估波及范围。纯图谱查询、零 LLM、快——等价于 trace_callers + trace_callees 合并成一屏。结果反映上次索引时的状态。',
    inputSchema: {
      symbol: z.string().trim().min(1, 'symbol 不能为空').describe('符号名（可先用 search_symbols 确认）'),
      depth: z.number().int().positive().optional().describe('追踪深度，默认 3'),
    },
  },
  handler: async (args) => {
    const { symbol, depth } = args as { symbol: string; depth?: number };
    // 上游走 /api/why（query 参数叫 target），下游走 /api/trace；两跳纯图谱、可并行
    const [upstream, downstream] = await Promise.all([
      analyzerGet<WhyResp>('/api/why', { target: symbol, depth }),
      analyzerGet<TraceResp>('/api/trace', { symbol, depth }),
    ]);
    return text(formatImpactScope(symbol, upstream, downstream));
  },
};
