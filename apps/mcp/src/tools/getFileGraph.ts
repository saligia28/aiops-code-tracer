import { z } from 'zod';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { analyzerGet } from '../client.js';
import { formatGraph } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface FileResp { file: string; nodes: GraphNode[]; edges: GraphEdge[] }

export const getFileGraph: ToolDescriptor = {
  name: 'get_file_graph',
  config: {
    description:
      '列出某个文件内的所有符号节点及相关关系（按相对路径精确匹配）。结果反映上次索引时的状态。',
    inputSchema: { path: z.string().describe('文件的相对路径，例 src/services/user.ts') },
  },
  handler: async (args) => {
    const { path } = args as { path: string };
    const data = await analyzerGet<FileResp>('/api/graph/file', { path });
    return text(`文件 ${data.file}：\n${formatGraph(data.nodes, data.edges)}`);
  },
};
