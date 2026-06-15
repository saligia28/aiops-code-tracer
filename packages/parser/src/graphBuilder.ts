import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphEdge, RepoConfig } from '@aiops/shared-types';
import { GraphStore } from '@aiops/graph-core';
import type { FileParseResult } from './extractors/types.js';
import { buildSymbolIndex, buildFileIndex, buildApiIndex, buildRouteIndex } from './symbolIndex.js';
import type { SymbolIndex, FileIndex, ApiIndex, RouteIndex } from './symbolIndex.js';
import { getParserForExtension, getEnabledParsers } from './languages/registry.js';
import type { ParserContext } from './languages/types.js';
import { buildCrossLanguageEdges } from './crossLanguage.js';

// 向后兼容再导出：TS/Vue 的单文件解析与跨文件求解逻辑已迁入 languages/typescript。
// 现有 graphBuilder 测试与 index.ts 旧导出经此入口，签名/语义不变。
export { parseFileFromDisk as parseFile, resolvePhase } from './languages/typescript/index.js';

export interface BuildResult {
  graph: GraphStore;
  symbolIndex: SymbolIndex;
  fileIndex: FileIndex;
  apiIndex: ApiIndex;
  routeIndex: RouteIndex;
  stats: BuildStats;
}

export interface BuildStats {
  totalFiles: number;
  parsedFiles: number;
  failedFiles: string[];
  totalNodes: number;
  totalEdges: number;
  resolvedRefs: number;
  unresolvedRefs: number;
  totalRefs: number;
  resolveRate: string;
  /** 跨语言桥边数（前端 apiCall → 后端 routeEntry） */
  crossLanguageEdges: number;
  duration: number;
}

/**
 * 完整构建流程（语言无关编排层）：
 *   按扩展名路由 parser → 编排层读 I/O → parser.parseFile (Pass1)
 *   → 按 parserId 分组 → parser.resolve (Pass2) → GraphStore 组装 + 索引构建
 *
 * 因 Java parser 的 wasm 解析为异步，buildGraph 整体为 async。
 */
export async function buildGraph(
  files: string[],
  config: RepoConfig,
  onProgress?: (current: number, total: number, file: string) => void
): Promise<BuildResult> {
  const start = Date.now();
  const enabledIds = config.parsers; // 未接线时为 undefined → registry 默认回落 ['typescript']
  const ctx: ParserContext = { config };
  const fileResults: FileParseResult[] = [];
  const failedFiles: string[] = [];

  // Phase 1: 按扩展名路由 → 编排层读内容 → 各语言 parser 单文件解析
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file);

    const ext = path.extname(file).toLowerCase();
    const parser = getParserForExtension(ext, enabledIds);
    if (!parser) {
      // 没有启用的 parser 认领该扩展名 → 跳过（glob 已按启用 parser 限定，正常不命中）
      continue;
    }

    // 编排层统一负责文件 I/O（含 .vue 原始 SFC 文本，由 parser 内部提取 <script>）
    let content: string;
    try {
      content = fs.readFileSync(path.join(config.repoPath, file), 'utf-8');
    } catch {
      const fileName = path.basename(file);
      fileResults.push({
        filePath: file,
        parserId: parser.id,
        nodes: [{ id: `file:${file}:${fileName}`, type: 'file', name: fileName, filePath: file, loc: '1:1' }],
        edges: [],
        unresolvedRefs: [],
        error: 'FILE_READ_ERROR',
      });
      failedFiles.push(file);
      continue;
    }

    try {
      const result = await parser.parseFile(file, content, ctx);
      fileResults.push(result);
      if (result.error) {
        failedFiles.push(file);
      }
    } catch {
      failedFiles.push(file);
    }
  }

  // Phase 2: 按 parserId 分组，各语言 parser 各自做跨文件求解（own = 本语言，all = 全量预留跨语言）
  const resultsByParser = new Map<string, FileParseResult[]>();
  for (const fr of fileResults) {
    const arr = resultsByParser.get(fr.parserId);
    if (arr) {
      arr.push(fr);
    } else {
      resultsByParser.set(fr.parserId, [fr]);
    }
  }

  const allResolvedEdges: GraphEdge[] = [];
  let unresolvedCount = 0;
  let totalRefs = 0;
  for (const parser of getEnabledParsers(enabledIds)) {
    const own = resultsByParser.get(parser.id);
    if (!own || own.length === 0) continue;
    const resolveResult = await parser.resolve(own, fileResults, ctx);
    allResolvedEdges.push(...resolveResult.resolvedEdges);
    unresolvedCount += resolveResult.unresolvedCount;
    totalRefs += resolveResult.totalRefs;
  }

  // 组装 GraphStore
  const graph = new GraphStore();
  for (const fr of fileResults) {
    for (const node of fr.nodes) {
      graph.addNode(node);
    }
    for (const edge of fr.edges) {
      graph.addEdge(edge);
    }
  }
  for (const edge of allResolvedEdges) {
    graph.addEdge(edge);
  }

  // 收集所有节点和边用于构建索引
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  for (const fr of fileResults) {
    for (const node of fr.nodes) {
      allNodes.push(node);
    }
    for (const edge of fr.edges) {
      allEdges.push(edge);
    }
  }
  for (const edge of allResolvedEdges) {
    allEdges.push(edge);
  }

  // 构建索引
  const symbolIndex = buildSymbolIndex(allNodes);
  const fileIndex = buildFileIndex(allNodes);
  const apiIndex = buildApiIndex(allNodes, allEdges);
  const routeIndex = buildRouteIndex(allNodes, allEdges, config);

  // 跨语言桥：按 endpointKey 配对前端 apiCall ↔ 后端 routeEntry（仅入图，不回灌索引）
  const crossEdges = buildCrossLanguageEdges(apiIndex);
  for (const edge of crossEdges) {
    graph.addEdge(edge);
  }

  const duration = Date.now() - start;
  const resolvedRefs = totalRefs - unresolvedCount;

  return {
    graph,
    symbolIndex,
    fileIndex,
    apiIndex,
    routeIndex,
    stats: {
      totalFiles: files.length,
      parsedFiles: fileResults.filter(r => !r.error).length,
      failedFiles,
      totalNodes: graph.nodeCount,
      totalEdges: graph.edgeCount,
      resolvedRefs,
      unresolvedRefs: unresolvedCount,
      totalRefs,
      resolveRate: totalRefs > 0 ? ((resolvedRefs / totalRefs) * 100).toFixed(1) + '%' : 'N/A',
      crossLanguageEdges: crossEdges.length,
      duration,
    },
  };
}
