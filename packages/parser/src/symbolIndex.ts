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
  const symbols: Record<string, SymbolLocation[]> = {};
  const exports: Record<string, string[]> = {};

  for (const node of nodes) {
    if (node.type === 'file') continue;

    const key = node.name;
    if (!symbols[key]) {
      symbols[key] = [];
    }
    symbols[key].push({
      nodeId: node.id,
      filePath: node.filePath,
      loc: node.loc,
      type: node.type,
    });

    if (node.meta?.isExported) {
      if (!exports[node.filePath]) {
        exports[node.filePath] = [];
      }
      exports[node.filePath].push(node.name);
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
  const files: Record<string, string[]> = {};

  for (const node of nodes) {
    if (!files[node.filePath]) {
      files[node.filePath] = [];
    }
    files[node.filePath].push(node.id);
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
  const endpoints: Record<string, ApiCallLocation[]> = {};

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
      if (!endpoints[endpoint]) {
        endpoints[endpoint] = [];
      }
      endpoints[endpoint].push({
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
}

export interface RouteIndex {
  routes: RouteEntry[];
}

export function buildRouteIndex(
  _nodes: GraphNode[],
  _edges: GraphEdge[],
  _config: RepoConfig
): RouteIndex {
  // Week 1: 路由索引暂返回空，后续迭代实现
  return { routes: [] };
}
