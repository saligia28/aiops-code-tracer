/**
 * 跨语言图遍历桥（Phase 3，编排层）
 *
 * 由已构建的 ApiIndex.byEndpointKey 配对「前端 apiCall ↔ 后端 routeEntry」，
 * 产出 `apiCall --calls--> routeEntry` 实体边，让问答 traceForward 直接打通前端→后端。
 *
 * 语言无关：只读 ApiIndex（不触 tree-sitter、不进单语言 resolve）。endpoint 归一仍有
 * 模糊（模板路径 vs {id}），故置信度统一 medium，并标 reason='crossLanguageEndpoint'。
 */
import type { GraphEdge } from '@aiops/shared-types';
import type { ApiIndex } from './symbolIndex.js';

/** 每个 endpointKey 两侧各取的最大配对数，避免笛卡尔积爆炸 */
const BRIDGE_TOP_N = 3;

export function buildCrossLanguageEdges(apiIndex: ApiIndex): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const byKey = apiIndex.byEndpointKey;
  if (!byKey) return edges;

  for (const { clientCalls, serverRoutes } of Object.values(byKey)) {
    if (clientCalls.length === 0 || serverRoutes.length === 0) continue;
    const calls = clientCalls.slice(0, BRIDGE_TOP_N);
    const routes = serverRoutes.slice(0, BRIDGE_TOP_N);
    for (const call of calls) {
      for (const route of routes) {
        edges.push({
          from: call.nodeId,
          to: route.nodeId,
          type: 'calls',
          meta: { confidence: 'medium', reason: 'crossLanguageEndpoint' },
        });
      }
    }
  }

  return edges;
}
