import type { FastifyInstance } from 'fastify';
import { graphStore, currentRepoName } from '../context.js';

export function registerHealth(app: FastifyInstance): void {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      graphLoaded: !!graphStore,
      repoName: currentRepoName,
    };
  });
}
