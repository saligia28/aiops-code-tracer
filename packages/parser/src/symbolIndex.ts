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
  /** 规范化端点键 "METHOD path"，用于跨语言聚合 */
  endpointKey?: string;
  kind?: 'clientCall';
}

/** 服务端路由（后端 HTTP 端点），来自 routeEntry 节点 */
export interface ServerRouteLocation {
  nodeId: string;
  filePath: string;
  loc: string;
  httpMethod: string;
  routePath: string;
  endpointKey: string;
  handlerNodeId?: string;
  kind: 'serverRoute';
}

export interface ApiIndex {
  /** 旧结构：path → 客户端调用[]（前端/API 既有消费，保持不变） */
  endpoints: Record<string, ApiCallLocation[]>;
  /** 后端路由（serverRoute） */
  serverRoutes?: ServerRouteLocation[];
  /** 跨语言聚合：endpointKey → { 前端调用, 后端路由 }（索引层桥，不产实体边） */
  byEndpointKey?: Record<string, { clientCalls: ApiCallLocation[]; serverRoutes: ServerRouteLocation[] }>;
}

/** 规范化路径：去 query/hash、折叠重复斜杠、去尾斜杠（root 保留 '/'） */
function normalizePath(p: string): string {
  const cleaned = (p ?? '').split('?')[0].split('#')[0];
  const parts = cleaned.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

/** 端点键 "METHOD path"，前后端共用以便聚合 */
export function normalizeEndpointKey(method: string | undefined, path: string): string {
  return `${(method || 'GET').toUpperCase()} ${normalizePath(path)}`;
}

export function buildApiIndex(nodes: GraphNode[], edges: GraphEdge[]): ApiIndex {
  const endpoints = Object.create(null) as Record<string, ApiCallLocation[]>;
  const serverRoutes: ServerRouteLocation[] = [];

  // apiCall 的调用方（calls 边）；routeEntry 的处理方（registersRoute 边）
  const callerMap = new Map<string, string>();
  const handlerByRoute = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type === 'calls') callerMap.set(edge.to, edge.from);
    else if (edge.type === 'registersRoute') handlerByRoute.set(edge.from, edge.to);
  }

  for (const node of nodes) {
    if (node.type === 'apiCall' && node.meta?.apiEndpoint) {
      const endpoint = node.meta.apiEndpoint;
      const method = node.meta.apiMethod ?? 'UNKNOWN';
      const endpointCalls = endpoints[endpoint] ?? (endpoints[endpoint] = []);
      endpointCalls.push({
        nodeId: node.id,
        filePath: node.filePath,
        loc: node.loc,
        method,
        callerNodeId: callerMap.get(node.id),
        endpointKey: normalizeEndpointKey(method, endpoint),
        kind: 'clientCall',
      });
    } else if (node.type === 'routeEntry' && node.meta?.apiEndpoint) {
      const routePath = node.meta.apiEndpoint;
      const httpMethod = node.meta.apiMethod ?? 'UNKNOWN';
      serverRoutes.push({
        nodeId: node.id,
        filePath: node.filePath,
        loc: node.loc,
        httpMethod,
        routePath,
        endpointKey: normalizeEndpointKey(httpMethod, routePath),
        handlerNodeId: handlerByRoute.get(node.id),
        kind: 'serverRoute',
      });
    }
  }

  // 跨语言聚合：同 endpointKey 下并列前端调用与后端路由
  const byEndpointKey: Record<
    string,
    { clientCalls: ApiCallLocation[]; serverRoutes: ServerRouteLocation[] }
  > = Object.create(null);
  const bucket = (key: string) =>
    byEndpointKey[key] ?? (byEndpointKey[key] = { clientCalls: [], serverRoutes: [] });
  for (const calls of Object.values(endpoints)) {
    for (const call of calls) {
      if (call.endpointKey) bucket(call.endpointKey).clientCalls.push(call);
    }
  }
  for (const route of serverRoutes) {
    bucket(route.endpointKey).serverRoutes.push(route);
  }

  return { endpoints, serverRoutes, byEndpointKey };
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
