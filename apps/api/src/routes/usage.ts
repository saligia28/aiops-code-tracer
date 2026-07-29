/**
 * 成本查询端点（设计文档 §12.3）。
 *
 * 安全口径：turn 必须属于**当前项目**，否则一律 404（不区分"不存在"与"跨项目"——
 * 区分了就等于给了枚举其他项目 turn 的接口）。
 * 只返回受控 usage 字段：没有 prompt、没有回答、没有错误原文。
 */
import type { FastifyInstance } from 'fastify';
import { resolveActiveProjectId } from '../context.js';
import { getTurnEvents, getTurnProjectId, getTurnSummary } from '../db/usageStore.js';

export function registerUsage(app: FastifyInstance): void {
  app.get('/api/usage/turns/:turnId', async (request, reply) => {
    const { turnId } = request.params as { turnId: string };

    const summary = getTurnSummary(turnId);
    // degraded tracker 的 turnId 从未落库，这里 404 是预期行为（UI 会提示"本轮追踪未持久化"）
    if (!summary) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '该轮成本记录不存在或已被清理' });
    }

    const owner = getTurnProjectId(turnId);
    if (owner !== resolveActiveProjectId()) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '该轮成本记录不存在或已被清理' });
    }

    return { summary, events: getTurnEvents(turnId) };
  });
}
