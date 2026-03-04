import type { CodeGraph, GraphNode, GraphEdge } from '@aiops/shared-types';

/**
 * 代码图谱核心存储与查询
 */
export class GraphStore {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private outEdges: Map<string, GraphEdge[]> = new Map();
  private inEdges: Map<string, GraphEdge[]> = new Map();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);

    if (!this.outEdges.has(edge.from)) {
      this.outEdges.set(edge.from, []);
    }
    this.outEdges.get(edge.from)!.push(edge);

    if (!this.inEdges.has(edge.to)) {
      this.inEdges.set(edge.to, []);
    }
    this.inEdges.get(edge.to)!.push(edge);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getOutEdges(nodeId: string): GraphEdge[] {
    return this.outEdges.get(nodeId) ?? [];
  }

  getInEdges(nodeId: string): GraphEdge[] {
    return this.inEdges.get(nodeId) ?? [];
  }

  /**
   * 正向追踪：从指定节点出发，沿边向下追踪
   */
  traceForward(startId: string, depth: number = 3): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>();
    const resultEdges: GraphEdge[] = [];

    const traverse = (nodeId: string, currentDepth: number) => {
      if (currentDepth > depth || visitedNodes.has(nodeId)) return;
      visitedNodes.add(nodeId);

      for (const edge of this.getOutEdges(nodeId)) {
        resultEdges.push(edge);
        traverse(edge.to, currentDepth + 1);
      }
    };

    traverse(startId, 0);

    const resultNodes = [...visitedNodes]
      .map((id) => this.nodes.get(id))
      .filter(Boolean) as GraphNode[];

    return { nodes: resultNodes, edges: resultEdges };
  }

  /**
   * 反向追踪：从指定节点出发，沿边向上追踪触发源
   */
  traceBackward(startId: string, depth: number = 3): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>();
    const resultEdges: GraphEdge[] = [];

    const traverse = (nodeId: string, currentDepth: number) => {
      if (currentDepth > depth || visitedNodes.has(nodeId)) return;
      visitedNodes.add(nodeId);

      for (const edge of this.getInEdges(nodeId)) {
        resultEdges.push(edge);
        traverse(edge.from, currentDepth + 1);
      }
    };

    traverse(startId, 0);

    const resultNodes = [...visitedNodes]
      .map((id) => this.nodes.get(id))
      .filter(Boolean) as GraphNode[];

    return { nodes: resultNodes, edges: resultEdges };
  }

  /**
   * 按符号名模糊搜索
   */
  searchByName(query: string): GraphNode[] {
    const lowerQuery = query.toLowerCase();
    return [...this.nodes.values()].filter(
      (node) => node.name.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 导出完整图谱
   */
  toJSON(): CodeGraph {
    return {
      nodes: [...this.nodes.values()],
      edges: this.edges,
      meta: {
        repoName: '',
        scanTime: new Date().toISOString(),
        totalFiles: new Set([...this.nodes.values()].map((n) => n.filePath)).size,
        totalNodes: this.nodes.size,
        totalEdges: this.edges.length,
        failedFiles: [],
      },
    };
  }

  /**
   * 从 JSON 加载图谱
   */
  static fromJSON(data: CodeGraph): GraphStore {
    const store = new GraphStore();
    for (const node of data.nodes) {
      store.addNode(node);
    }
    for (const edge of data.edges) {
      store.addEdge(edge);
    }
    return store;
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }
}
