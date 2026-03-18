import type { FastifyInstance } from 'fastify';
import { graphStore } from '../context.js';
import {
  ensureGraph,
  resolveSymbolToNodeId,
} from '../services/askService.js';

export function registerTrace(app: FastifyInstance): void {
  app.get('/api/trace', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { symbol, depth } = request.query as { symbol: string; depth?: string };
    if (!symbol) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 symbol 参数' });
    }

    const nodeId = resolveSymbolToNodeId(symbol);
    if (!nodeId) {
      return { symbol, depth: Number(depth) || 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
    }

    const result = graphStore!.traceForward(nodeId, Number(depth) || 3);
    return { symbol, nodeId, depth: Number(depth) || 3, ...result };
  });

  app.get('/api/why', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { target, depth } = request.query as { target: string; depth?: string };
    if (!target) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 target 参数' });
    }

    const nodeId = resolveSymbolToNodeId(target);
    if (!nodeId) {
      return { target, depth: Number(depth) || 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
    }

    const result = graphStore!.traceBackward(nodeId, Number(depth) || 3);
    return { target, nodeId, depth: Number(depth) || 3, ...result };
  });

  app.get('/api/search', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { q, limit } = request.query as { q: string; limit?: string };
    if (!q) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 q 参数' });
    }

    const results = graphStore!.searchByName(q);
    const maxResults = Number(limit) || 50;
    return { query: q, total: results.length, results: results.slice(0, maxResults) };
  });
}
