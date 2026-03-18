import type { FastifyInstance } from 'fastify';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { graphStore } from '../context.js';
import { ensureGraph, resolveSymbolToNodeId } from '../services/askService.js';

export function registerGraph(app: FastifyInstance): void {
  app.get('/api/graph/stats', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const graphJson = graphStore!.toJSON();
    const nodeTypes: Record<string, number> = {};
    const edgeTypes: Record<string, number> = {};
    for (const node of graphJson.nodes) {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
    }
    for (const edge of graphJson.edges) {
      edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
    }

    return {
      totalNodes: graphStore!.nodeCount,
      totalEdges: graphStore!.edgeCount,
      nodeTypes,
      edgeTypes,
    };
  });

  app.get('/api/graph/file', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { path: filePath } = request.query as { path: string };
    if (!filePath) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 path 参数' });
    }

    const graphJson = graphStore!.toJSON();
    const nodes = graphJson.nodes.filter(n => n.filePath === filePath);
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = graphJson.edges.filter(e => nodeIds.has(e.from) || nodeIds.has(e.to));

    return { file: filePath, nodes, edges };
  });

  app.get('/api/graph/symbol', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { name } = request.query as { name: string };
    if (!name) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 name 参数' });
    }

    const nodeId = resolveSymbolToNodeId(name);
    if (!nodeId) {
      return { symbol: name, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
    }

    const forward = graphStore!.traceForward(nodeId, 1);
    const backward = graphStore!.traceBackward(nodeId, 1);

    const nodeMap = new Map<string, GraphNode>();
    for (const n of [...forward.nodes, ...backward.nodes]) {
      nodeMap.set(n.id, n);
    }
    const edgeSet = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const e of [...forward.edges, ...backward.edges]) {
      const key = `${e.from}->${e.to}:${e.type}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push(e);
      }
    }

    return { symbol: name, nodeId, nodes: [...nodeMap.values()], edges };
  });

  app.get('/api/graph/module', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { name } = request.query as { name: string };
    if (!name) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 name 参数' });
    }

    const graphJson = graphStore!.toJSON();
    const nodes = graphJson.nodes.filter(n => n.filePath.includes(name));
    const nodeIds = new Set(nodes.map(n => n.id));
    const edges = graphJson.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

    return { module: name, nodes, edges };
  });
}
