import type { FastifyInstance } from 'fastify';
import { resolveActiveProjectId } from '../context.js';
import { deleteMemory, listMemories } from '../db/memoryStore.js';

// ============================================================
// 记忆路由：当前项目记忆列表 / 删除单条
// ============================================================

export function registerMemories(app: FastifyInstance): void {
  // 当前项目的全部记忆（created_at DESC）
  app.get('/api/memories', async (_request, reply) => {
    try {
      return listMemories(resolveActiveProjectId());
    } catch (error) {
      return reply.code(500).send({
        error: 'MEMORY_LIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 删除单条记忆
  app.delete('/api/memories/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      deleteMemory(id);
      return { ok: true };
    } catch (error) {
      return reply.code(500).send({
        error: 'MEMORY_DELETE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
