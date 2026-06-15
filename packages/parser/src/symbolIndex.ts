import type { GraphNode, GraphEdge, RepoConfig } from '@aiops/shared-types';

// ============================================================
// SymbolIndex — 符号名 → 位置列表
// ============================================================

export interface SymbolLocation {
  nodeId: string;
  filePath: string;
  loc: string;
  type: string;
}

export interface SymbolIndex {
  /** 符号名 → 位置列表 */
  symbols: Record<string, SymbolLocation[]>;
  /** 文件 → 导出符号列表 */
  exports: Record<string, string[]>;
}

export function buildSymbolIndex(nodes: GraphNode[]): SymbolIndex {
  const symbols = Object.create(null) as Record<string, SymbolLocation[]>;
  const exports = Object.create(null) as Record<string, string[]>;

  for (const node of nodes) {
    if (node.type === 'file') continue;

    const key = node.name;
    const symbolLocations = symbols[key] ?? (symbols[key] = []);
    symbolLocations.push({
      nodeId: node.id,
      filePath: node.filePath,
      loc: node.loc,
      type: node.type,
    });

    if (node.meta?.isExported) {
      const exportedSymbols = exports[node.filePath] ?? (exports[node.filePath] = []);
      exportedSymbols.push(node.name);
    }
  }

  return { symbols, exports };
}

// ============================================================
// FileIndex — 文件 → 节点 ID 列表
// ============================================================

export interface FileIndex {
  files: Record<string, string[]>;
}

export function buildFileIndex(nodes: GraphNode[]): FileIndex {
  const files = Object.create(null) as Record<string, string[]>;

  for (const node of nodes) {
    const fileNodes = files[node.filePath] ?? (files[node.filePath] = []);
    fileNodes.push(node.id);
  }

  return { files };
}

// ============================================================
// ApiIndex — endpoint → 调用位置列表
// ============================================================

export interface ApiCallLocation {
  nodeId: string;
  filePath: string;
  loc: string;
  method: string;
  callerNodeId?: string;
}

export interface ApiIndex {
  endpoints: Record<string, ApiCallLocation[]>;
}

export function buildApiIndex(nodes: GraphNode[], edges: GraphEdge[]): ApiIndex {
  const endpoints = Object.create(null) as Record<string, ApiCallLocation[]>;

  // 找到调用 apiCall 节点的边
  const callerMap = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === 'calls') {
      callerMap.set(edge.to, edge.from);
    }
  }

  for (const node of nodes) {
    if (node.type === 'apiCall' && node.meta?.apiEndpoint) {
      const endpoint = node.meta.apiEndpoint;
      const endpointCalls = endpoints[endpoint] ?? (endpoints[endpoint] = []);
      endpointCalls.push({
        nodeId: node.id,
        filePath: node.filePath,
        loc: node.loc,
        method: node.meta.apiMethod ?? 'UNKNOWN',
        callerNodeId: callerMap.get(node.id),
      });
    }
  }

  return { endpoints };
}

// ============================================================
// RouteIndex — 路由路径 → 组件
// ============================================================

export interface RouteEntry {
  routePath: string;
  componentFilePath?: string;
  nodeId: string;
  /** HTTP 方法（serverRoute），如 GET/POST */
  httpMethod?: string;
  /** 处理该路由的方法节点 id（serverRoute，经 registersRoute 边定位） */
  handlerNodeId?: string;
  /** 路由类型：服务端路由（后端 HTTP 端点）或客户端路由（前端） */
  kind?: 'serverRoute' | 'clientRoute';
}

export interface RouteIndex {
  routes: RouteEntry[];
}

/**
 * 路由索引（最小实现）：从 routeEntry 节点产出 serverRoute 条目，
 * 经 registersRoute 边定位其处理方法。clientRoute 待后续迭代。
 */
export function buildRouteIndex(
  nodes: GraphNode[],
  edges: GraphEdge[],
  _config: RepoConfig
): RouteIndex {
  // routeEntry id → handler 方法节点 id
  const handlerByRoute = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === 'registersRoute') {
      handlerByRoute.set(edge.from, edge.to);
    }
  }

  const routes: RouteEntry[] = [];
  for (const node of nodes) {
    if (node.type !== 'routeEntry') continue;
    routes.push({
      routePath: node.meta?.apiEndpoint ?? node.name,
      nodeId: node.id,
      httpMethod: node.meta?.apiMethod,
      handlerNodeId: handlerByRoute.get(node.id),
      kind: 'serverRoute',
    });
  }

  return { routes };
}
