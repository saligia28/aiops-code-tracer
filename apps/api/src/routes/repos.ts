import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR,
  graphStore,
  currentRepoName,
} from '../context.js';
import { loadGraph } from '../services/indexService.js';

export function registerRepos(app: FastifyInstance): void {
  app.get('/api/repos', async () => {
    const repos: Array<{
      repoName: string;
      hasGraph: boolean;
      totalFiles?: number;
      totalNodes?: number;
      totalEdges?: number;
      lastBuildTime?: string;
    }> = [];

    if (fs.existsSync(DATA_DIR)) {
      const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const name of dirs) {
        const repoDir = path.join(DATA_DIR, name);
        const graphPath = path.join(repoDir, 'graph.json');
        const metaPath = path.join(repoDir, 'meta.json');
        const hasGraph = fs.existsSync(graphPath);

        const entry: (typeof repos)[number] = { repoName: name, hasGraph };

        if (hasGraph && fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            entry.totalFiles = meta.totalFiles;
            entry.totalNodes = meta.totalNodes;
            entry.totalEdges = meta.totalEdges;
            entry.lastBuildTime = meta.finishedAt ?? meta.lastBuildTime;
          } catch { /* meta 解析失败忽略 */ }
        }

        repos.push(entry);
      }
    }

    return { currentRepo: currentRepoName, repos };
  });

  app.post('/api/repos/switch', async (request, reply) => {
    const { repoName } = (request.body as { repoName?: string }) || {};
    if (!repoName || !repoName.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 repoName 参数' });
    }

    const repoDir = path.join(DATA_DIR, repoName);
    if (!fs.existsSync(repoDir)) {
      return reply.code(404).send({ error: 'REPO_NOT_FOUND', message: `仓库 ${repoName} 不存在` });
    }

    const ok = loadGraph(repoName, app.log);
    if (!ok) {
      return reply.code(500).send({ error: 'LOAD_FAILED', message: `加载仓库 ${repoName} 失败` });
    }

    return {
      message: `已切换到仓库 ${repoName}`,
      repoName: currentRepoName,
      totalNodes: graphStore?.nodeCount ?? 0,
      totalEdges: graphStore?.edgeCount ?? 0,
    };
  });
}
