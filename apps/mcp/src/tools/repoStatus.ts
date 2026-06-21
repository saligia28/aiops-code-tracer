import { analyzerGet } from '../client.js';
import { formatRepoStatus, type RepoEntry } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

interface ReposResp { currentRepo: string | null; repos: RepoEntry[] }

export const repoStatus: ToolDescriptor = {
  name: 'repo_status',
  config: {
    description:
      '查看分析服务当前加载的是哪个仓库，以及有哪些可用仓库。在一串代码分析的开头先调用它确认目标仓库——其余工具查询的就是这个「当前仓库」。',
    inputSchema: {},
  },
  handler: async () => {
    const data = await analyzerGet<ReposResp>('/api/repos');
    return text(formatRepoStatus(data.currentRepo, data.repos));
  },
};
