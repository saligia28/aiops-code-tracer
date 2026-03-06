import type { CodeGraph, GraphNode, GraphEdge } from '@aiops/shared-types';

/**
 * 代码图谱核心存储与查询
 */
export class GraphStore {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private outEdges: Map<string, GraphEdge[]> = new Map();
  private inEdges: Map<string, GraphEdge[]> = new Map();
  private nameIndex: Map<string, GraphNode[]> = new Map();

  addNode(node: GraphNode): void {
    // @ts-ignore — dev-only 冲突检测，无 @types/node 时忽略
    if (typeof globalThis.process !== 'undefined' && globalThis.process.env?.NODE_ENV !== 'production' && this.nodes.has(node.id)) {
      console.warn(`[GraphStore] 节点 ID 冲突: ${node.id}`);
    }
    this.nodes.set(node.id, node);
    // 建立名称倒排索引
    const tokens = this.tokenize(node.name);
    for (const token of tokens) {
      const list = this.nameIndex.get(token) ?? [];
      list.push(node);
      this.nameIndex.set(token, list);
    }
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
   * 获取所有节点
   */
  getAllNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /**
   * 获取指定文件的所有节点
   */
  getNodesByFile(filePath: string): GraphNode[] {
    return [...this.nodes.values()].filter((node) => node.filePath === filePath);
  }

  /**
   * 获取所有边
   */
  getAllEdges(): GraphEdge[] {
    return this.edges;
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
   * 双向合并追踪：同时正向和反向追踪，合并结果
   */
  traceBidirectional(
    startId: string,
    forwardDepth: number = 3,
    backwardDepth: number = 2
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const forward = this.traceForward(startId, forwardDepth);
    const backward = this.traceBackward(startId, backwardDepth);

    const nodeMap = new Map<string, GraphNode>();
    for (const node of forward.nodes) nodeMap.set(node.id, node);
    for (const node of backward.nodes) nodeMap.set(node.id, node);

    const edgeSet = new Set<string>();
    const mergedEdges: GraphEdge[] = [];
    for (const edge of [...forward.edges, ...backward.edges]) {
      const key = `${edge.from}|${edge.to}|${edge.type}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        mergedEdges.push(edge);
      }
    }

    return {
      nodes: [...nodeMap.values()],
      edges: mergedEdges,
    };
  }

  /**
   * 按符号名模糊搜索（使用倒排索引加速）
   */
  searchByName(query: string): GraphNode[] {
    const tokens = this.tokenize(query);
    if (tokens.length === 0) {
      // 回退到全量扫描
      const lowerQuery = query.toLowerCase();
      return [...this.nodes.values()].filter(
        (node) => node.name.toLowerCase().includes(lowerQuery)
      );
    }

    const candidates = new Map<string, { node: GraphNode; hits: number }>();
    for (const token of tokens) {
      for (const node of this.nameIndex.get(token) ?? []) {
        const entry = candidates.get(node.id) ?? { node, hits: 0 };
        entry.hits++;
        candidates.set(node.id, entry);
      }
    }

    // 补充：对未通过 token 索引命中但名称包含查询的节点，做线性扫描兜底
    const lowerQuery = query.toLowerCase();
    for (const node of this.nodes.values()) {
      if (candidates.has(node.id)) continue;
      if (node.name.toLowerCase().includes(lowerQuery)) {
        candidates.set(node.id, { node, hits: 1 });
      }
    }

    return [...candidates.values()]
      .sort((a, b) => b.hits - a.hits)
      .map((e) => e.node);
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

  /**
   * 将名称分词为索引 token
   */
  private tokenize(name: string): string[] {
    const lower = name.toLowerCase();
    const tokens: string[] = [];

    // 按非字母数字字符分割
    const parts = lower.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
    tokens.push(...parts);

    // camelCase 分割: handleSubmitClick → [handle, submit, click]
    const rawParts = name.split(/[^A-Za-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
    for (const part of rawParts) {
      const camelParts = part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (camelParts.length > 1) {
        tokens.push(...camelParts);
      }
    }

    // 中文按字符拆分为 2-gram
    for (const part of parts) {
      if (/[\u4e00-\u9fa5]/.test(part)) {
        const chars = Array.from(part.match(/[\u4e00-\u9fa5]+/g) ?? []).join('');
        for (let i = 0; i < chars.length - 1; i++) {
          tokens.push(chars.slice(i, i + 2));
        }
      }
    }

    return [...new Set(tokens)].filter((t) => t.length >= 2);
  }
}
