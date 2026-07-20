import type { FastifyInstance } from 'fastify';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { graphStore } from '../context.js';
import {
  ensureGraph,
  resolveSymbolToNodeId,
} from '../services/askService.js';

// ============================================================
// 文件级影响面（P1-MCP：get_impact_scope 的 file 入参）
// 在服务端聚合而非让 MCP 逐符号扇出——一个大文件几十个符号 ×2 方向的
// 请求风暴不该发生在传输层。
// ============================================================

/** 聚合上限：根符号数 / 结果节点数 / 结果边数（防大文件把响应撑爆） */
const FILE_IMPACT_MAX_ROOTS = 40;
const FILE_IMPACT_MAX_NODES = 200;
const FILE_IMPACT_MAX_EDGES = 300;

/**
 * 解析文件参数：精确相对路径优先，其次唯一后缀匹配（"List.vue" 这类短名在多页面仓库
 * 常一名多处——命中多个时返回候选列表交调用方消歧，绝不静默选一个）。
 */
function resolveFileParam(input: string): { file?: string; candidates?: string[] } {
  const paths = new Set<string>();
  for (const n of graphStore!.toJSON().nodes) if (n.filePath) paths.add(n.filePath);
  if (paths.has(input)) return { file: input };
  const suffix = input.startsWith('/') ? input : `/${input}`;
  const hits = [...paths].filter((p) => p.endsWith(suffix)).sort();
  if (hits.length === 1) return { file: hits[0] };
  if (hits.length === 0) return {};
  return { candidates: hits.slice(0, 10) };
}

/**
 * 文件级影响面：对文件内全部实体符号（跳过 file/import 结构节点）聚合 trace，
 * 只保留「跨出本文件」的边——文件内部调用在影响面场景是噪声；本文件节点仅在
 * 参与跨界边时保留（作为"从哪里跨出去"的边界锚点）。
 */
function traceFileImpact(
  filePath: string,
  depth: number,
  direction: 'forward' | 'backward',
): { nodes: GraphNode[]; edges: GraphEdge[]; sourceSymbols: number } {
  const graphJson = graphStore!.toJSON();
  const roots = graphJson.nodes
    .filter((n) => n.filePath === filePath && n.type !== 'file' && n.type !== 'import')
    .slice(0, FILE_IMPACT_MAX_ROOTS);

  const keptNodes = new Map<string, GraphNode>();
  const keptEdges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  outer: for (const root of roots) {
    const r =
      direction === 'forward'
        ? graphStore!.traceForward(root.id, depth)
        : graphStore!.traceBackward(root.id, depth);
    const byId = new Map(r.nodes.map((n) => [n.id, n] as const));
    for (const e of r.edges) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      // 至少一端在文件外才是影响面；两端都在本文件的内部边丢弃
      const crossesFile = (from && from.filePath !== filePath) || (to && to.filePath !== filePath);
      if (!crossesFile) continue;
      const key = `${e.from}->${e.to}:${e.type}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      keptEdges.push(e);
      for (const n of [from, to]) if (n && !keptNodes.has(n.id)) keptNodes.set(n.id, n);
      if (keptEdges.length >= FILE_IMPACT_MAX_EDGES || keptNodes.size >= FILE_IMPACT_MAX_NODES) break outer;
    }
  }

  return { nodes: [...keptNodes.values()], edges: keptEdges, sourceSymbols: roots.length };
}

export function registerTrace(app: FastifyInstance): void {
  app.get('/api/trace', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { symbol, file, depth } = request.query as { symbol?: string; file?: string; depth?: string };
    const d = Number(depth) || 3;
    if (symbol && file) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: 'symbol 与 file 只能提供一个' });
    }
    if (file) {
      const resolved = resolveFileParam(file);
      if (resolved.candidates) return { file, depth: d, nodes: [], edges: [], message: 'FILE_AMBIGUOUS', candidates: resolved.candidates };
      if (!resolved.file) return { file, depth: d, nodes: [], edges: [], message: 'FILE_NOT_FOUND' };
      return { file: resolved.file, depth: d, ...traceFileImpact(resolved.file, d, 'forward') };
    }
    if (!symbol) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 symbol 参数（或改用 file 参数）' });
    }

    const nodeId = resolveSymbolToNodeId(symbol);
    if (!nodeId) {
      return { symbol, depth: d, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
    }

    const result = graphStore!.traceForward(nodeId, d);
    return { symbol, nodeId, depth: d, ...result };
  });

  app.get('/api/why', async (request, reply) => {
    if (!ensureGraph(reply)) return;

    const { target, file, depth } = request.query as { target?: string; file?: string; depth?: string };
    const d = Number(depth) || 3;
    if (target && file) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: 'target 与 file 只能提供一个' });
    }
    if (file) {
      const resolved = resolveFileParam(file);
      if (resolved.candidates) return { file, depth: d, nodes: [], edges: [], message: 'FILE_AMBIGUOUS', candidates: resolved.candidates };
      if (!resolved.file) return { file, depth: d, nodes: [], edges: [], message: 'FILE_NOT_FOUND' };
      return { file: resolved.file, depth: d, ...traceFileImpact(resolved.file, d, 'backward') };
    }
    if (!target) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 target 参数（或改用 file 参数）' });
    }

    const nodeId = resolveSymbolToNodeId(target);
    if (!nodeId) {
      return { target, depth: d, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' };
    }

    const result = graphStore!.traceBackward(nodeId, d);
    return { target, nodeId, depth: d, ...result };
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
