import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet, AnalyzerError } from '../client.js';
import { formatImpactScope, type ImpactSide } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface WhyResp extends ImpactSide { target?: string; file?: string }
interface TraceResp extends ImpactSide { symbol?: string; file?: string }

export const getImpactScope: ToolDescriptor = {
  name: 'get_impact_scope',
  config: {
    description:
      '一次拿到某符号或某文件的完整影响面：上游调用方（改动会波及谁）+ 下游依赖（改动依赖什么）。改一个函数/文件前先调它评估波及范围。文件模式聚合文件内全部符号、只看跨文件影响。纯图谱查询、零 LLM、快——等价于 trace_callers + trace_callees 合并成一屏。结果反映上次索引时的状态。',
    inputSchema: {
      symbol: z.string().trim().min(1, 'symbol 不能为空').optional().describe('符号名（与 file 二选一；可先用 search_symbols 确认）'),
      file: z.string().trim().min(1, 'file 不能为空').optional().describe('文件相对路径（与 symbol 二选一）；短文件名（如 List.vue）唯一命中时可用，多命中会返回候选列表'),
      depth: z.number().int().positive().optional().describe('追踪深度，默认 3'),
    },
  },
  handler: async (args) => {
    const { symbol, file, depth } = args as { symbol?: string; file?: string; depth?: number };
    // zod raw shape 做不了跨字段约束，二选一在这里守
    if (!!symbol === !!file) {
      throw new AnalyzerError('symbol 与 file 必须且只能提供一个。');
    }
    const label = (symbol ?? file)!;
    // 上游走 /api/why（符号模式 query 参数叫 target），下游走 /api/trace；两跳纯图谱、可并行
    const [upstream, downstream] = await Promise.all([
      analyzerGet<WhyResp>('/api/why', symbol ? { target: symbol, depth } : { file, depth }),
      analyzerGet<TraceResp>('/api/trace', symbol ? { symbol, depth } : { file, depth }),
    ]);
    return text(formatImpactScope(label, upstream, downstream));
  },
};
