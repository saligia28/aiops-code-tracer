import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphEdge, RepoConfig } from '@aiops/shared-types';
import { GraphStore } from '@aiops/graph-core';
import { parseVueSfc } from './scanner/vueSfcParser.js';
import { extractImports } from './extractors/extractImports.js';
import { extractFunctions } from './extractors/extractFunctions.js';
import { extractCalls } from './extractors/extractCalls.js';
import { extractAssignments } from './extractors/extractAssignments.js';
import type { FileParseResult, UnresolvedRef, ExtractorContext } from './extractors/types.js';
import { buildSymbolIndex, buildFileIndex, buildApiIndex, buildRouteIndex } from './symbolIndex.js';
import type { SymbolIndex, FileIndex, ApiIndex, RouteIndex } from './symbolIndex.js';

/**
 * 根据文件扩展名和 SFC lang 推断 ScriptKind
 */
function resolveScriptKind(filePath: string, sfcLang?: string | null): ts.ScriptKind {
  const lang = sfcLang?.toLowerCase();
  if (lang === 'tsx') return ts.ScriptKind.TSX;
  if (lang === 'ts') return ts.ScriptKind.TS;
  if (lang === 'jsx') return ts.ScriptKind.JSX;
  if (lang === 'js') return ts.ScriptKind.JS;

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * 单文件解析 — Phase 1
 */
export function parseFile(filePath: string, config: RepoConfig): FileParseResult {
  const absolutePath = path.join(config.repoPath, filePath);
  const fileName = path.basename(filePath);
  const fileNodeId = `file:${filePath}:${fileName}`;

  // 文件节点（每个文件必有）
  const fileNode: GraphNode = {
    id: fileNodeId,
    type: 'file',
    name: fileName,
    filePath,
    loc: '1:1',
  };

  const ext = path.extname(filePath).toLowerCase();
  let scriptContent: string | null = null;
  let scriptLang: string | null = null;
  let isSetupScript = false;

  if (ext === '.vue') {
    try {
      const sfcResult = parseVueSfc(absolutePath);
      scriptContent = sfcResult.scriptContent;
      scriptLang = sfcResult.scriptLang;
      isSetupScript = sfcResult.scriptSetup;
    } catch {
      return { filePath, nodes: [fileNode], edges: [], unresolvedRefs: [], error: 'SFC_PARSE_ERROR' };
    }
  } else {
    try {
      scriptContent = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      return { filePath, nodes: [fileNode], edges: [], unresolvedRefs: [], error: 'FILE_READ_ERROR' };
    }
  }

  if (!scriptContent) {
    return { filePath, nodes: [fileNode], edges: [], unresolvedRefs: [] };
  }

  const scriptKind = resolveScriptKind(filePath, scriptLang);
  const sourceFile = ts.createSourceFile(
    filePath,
    scriptContent,
    ts.ScriptTarget.ESNext,
    true,
    scriptKind
  );

  const ctx: ExtractorContext = {
    filePath,
    config,
    scriptContent,
    isSetupScript,
  };

  // 按序运行提取器
  const importResult = extractImports(sourceFile, ctx);
  const funcResult = extractFunctions(sourceFile, ctx);
  const callResult = extractCalls(sourceFile, ctx, funcResult.functionNodes);
  const assignResult = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

  return {
    filePath,
    nodes: [
      fileNode,
      ...importResult.nodes,
      ...funcResult.nodes,
      ...callResult.nodes,
      ...assignResult.nodes,
    ],
    edges: [
      ...importResult.edges,
      ...funcResult.edges,
      ...callResult.edges,
      ...assignResult.edges,
    ],
    unresolvedRefs: [
      ...importResult.unresolvedRefs,
      ...callResult.unresolvedRefs,
    ],
  };
}

interface ResolveResult {
  resolvedEdges: GraphEdge[];
  unresolvedCount: number;
  totalRefs: number;
}

/**
 * 跨文件边解析 — Phase 2
 *
 * 两级索引算法:
 * 1. exportMap: filePath → Map<symbolName, nodeId>
 * 2. importMap: filePath → Array<{localName, sourcePath, originalName}>
 * 3. autoImportSymbols: symbolName → nodeId
 */
export function resolvePhase(
  fileResults: FileParseResult[],
  config: RepoConfig
): ResolveResult {
  const resolvedEdges: GraphEdge[] = [];
  let unresolvedCount = 0;

  // 收集所有节点，按文件分组
  const nodesByFile = new Map<string, Map<string, string>>(); // filePath → Map<name, nodeId>
  const allNodeMap = new Map<string, GraphNode>(); // nodeId → node

  for (const fr of fileResults) {
    const fileMap = new Map<string, string>();
    for (const node of fr.nodes) {
      allNodeMap.set(node.id, node);
      if (node.type !== 'file' && node.type !== 'import') {
        fileMap.set(node.name, node.id);
      }
    }
    nodesByFile.set(fr.filePath, fileMap);
  }

  // 构建 exportMap: filePath → Map<symbolName, nodeId>
  const exportMap = new Map<string, Map<string, string>>();
  for (const fr of fileResults) {
    const exports = new Map<string, string>();
    for (const node of fr.nodes) {
      if (node.meta?.isExported) {
        exports.set(node.name, node.id);
        if (node.meta.isDefaultExport) {
          exports.set('default', node.id);
        }
      }
    }
    // 用标准化路径存储
    exportMap.set(fr.filePath, exports);
    // 同时存储无扩展名版本
    const noExt = stripExtension(fr.filePath);
    if (noExt !== fr.filePath) {
      exportMap.set(noExt, exports);
    }
  }

  // 构建 importMap: filePath → Array<{localName, sourcePath, originalName}>
  const importMapByFile = new Map<string, Array<{ localName: string; sourcePath: string; originalName: string }>>();
  for (const fr of fileResults) {
    const imports: Array<{ localName: string; sourcePath: string; originalName: string }> = [];
    for (const ref of fr.unresolvedRefs) {
      if (ref.refType === 'import' && ref.importSource) {
        imports.push({
          localName: ref.refName,
          sourcePath: ref.importSource,
          originalName: ref.originalName ?? ref.refName,
        });
      }
    }
    importMapByFile.set(fr.filePath, imports);
  }

  // 构建 autoImportSymbols
  const autoImportSymbols = new Map<string, string>();
  for (const dir of config.autoImportDirs) {
    for (const [filePath, exports] of exportMap.entries()) {
      if (filePath.startsWith(dir)) {
        for (const [symbolName, nodeId] of exports) {
          if (symbolName !== 'default') {
            autoImportSymbols.set(symbolName, nodeId);
          }
        }
      }
    }
  }

  // 收集所有非 import 类型的未解析引用
  const allRefs: Array<{ ref: UnresolvedRef; filePath: string }> = [];
  for (const fr of fileResults) {
    for (const ref of fr.unresolvedRefs) {
      if (ref.refType !== 'import') {
        allRefs.push({ ref, filePath: fr.filePath });
      }
    }
  }

  // 解析每个引用
  for (const { ref, filePath } of allRefs) {
    let resolved = false;

    // 策略1: 通过 importMap 查找 → 再到 exportMap 中找到目标
    const imports = importMapByFile.get(filePath) ?? [];
    const matchedImport = imports.find(i => i.localName === ref.refName);
    if (matchedImport) {
      const sourceExports = findExportMap(exportMap, matchedImport.sourcePath);
      if (sourceExports) {
        const targetId = sourceExports.get(matchedImport.originalName) ?? sourceExports.get(matchedImport.localName);
        if (targetId) {
          resolvedEdges.push({
            from: ref.fromNodeId,
            to: targetId,
            type: 'calls',
            loc: ref.loc,
          });
          resolved = true;
        }
      }
    }

    // 策略2: 同文件局部定义
    if (!resolved) {
      const localDefs = nodesByFile.get(filePath);
      if (localDefs) {
        const targetId = localDefs.get(ref.refName);
        if (targetId && targetId !== ref.fromNodeId) {
          resolvedEdges.push({
            from: ref.fromNodeId,
            to: targetId,
            type: 'calls',
            loc: ref.loc,
          });
          resolved = true;
        }
      }
    }

    // 策略2.5: 点号引用 — 取 baseName 在 importMap / 本地定义 / autoImport 中查找
    if (!resolved && ref.refName.includes('.')) {
      const baseName = ref.refName.split('.')[0];

      // 先查 importMap
      const matchedBaseImport = imports.find(i => i.localName === baseName);
      if (matchedBaseImport) {
        const sourceExports = findExportMap(exportMap, matchedBaseImport.sourcePath);
        if (sourceExports) {
          const targetId = sourceExports.get(matchedBaseImport.originalName) ?? sourceExports.get(matchedBaseImport.localName);
          if (targetId) {
            resolvedEdges.push({
              from: ref.fromNodeId,
              to: targetId,
              type: 'calls',
              loc: ref.loc,
            });
            resolved = true;
          }
        }
      }

      // 再查同文件局部定义
      if (!resolved) {
        const localDefs = nodesByFile.get(filePath);
        if (localDefs) {
          const targetId = localDefs.get(baseName);
          if (targetId && targetId !== ref.fromNodeId) {
            resolvedEdges.push({
              from: ref.fromNodeId,
              to: targetId,
              type: 'uses',
              loc: ref.loc,
            });
            resolved = true;
          }
        }
      }

      // 再查 autoImport
      if (!resolved) {
        const targetId = autoImportSymbols.get(baseName);
        if (targetId) {
          resolvedEdges.push({
            from: ref.fromNodeId,
            to: targetId,
            type: 'calls',
            loc: ref.loc,
          });
          resolved = true;
        }
      }
    }

    // 策略3: Vuex 全局节点
    if (!resolved && (ref.refName.startsWith('store.dispatch') || ref.refName.startsWith('store.commit'))) {
      // Vuex 调用暂不解析
    }

    // 策略4: autoImport 兜底
    if (!resolved) {
      const targetId = autoImportSymbols.get(ref.refName);
      if (targetId) {
        resolvedEdges.push({
          from: ref.fromNodeId,
          to: targetId,
          type: 'calls',
          loc: ref.loc,
        });
        resolved = true;
      }
    }

    if (!resolved) {
      unresolvedCount++;
    }
  }

  return {
    resolvedEdges,
    unresolvedCount,
    totalRefs: allRefs.length,
  };
}

/**
 * 在 exportMap 中查找（尝试带扩展名和不带扩展名）
 */
function findExportMap(
  exportMap: Map<string, Map<string, string>>,
  sourcePath: string
): Map<string, string> | undefined {
  // 精确匹配
  let result = exportMap.get(sourcePath);
  if (result) return result;

  // 尝试添加常见扩展名
  for (const ext of ['.ts', '.js', '.vue', '.tsx', '.jsx']) {
    result = exportMap.get(sourcePath + ext);
    if (result) return result;
  }

  // 尝试 index 文件
  for (const ext of ['.ts', '.js']) {
    result = exportMap.get(sourcePath + '/index' + ext);
    if (result) return result;
  }

  return undefined;
}

/**
 * 去掉文件扩展名
 */
function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|js|vue|tsx|jsx)$/, '');
}

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
  duration: number;
}

/**
 * 完整构建流程：parseFile + resolvePhase + GraphStore 组装 + 索引构建
 */
export function buildGraph(
  files: string[],
  config: RepoConfig,
  onProgress?: (current: number, total: number, file: string) => void
): BuildResult {
  const start = Date.now();
  const fileResults: FileParseResult[] = [];
  const failedFiles: string[] = [];

  // Phase 1: 单文件解析
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file);
    try {
      const result = parseFile(file, config);
      fileResults.push(result);
      if (result.error) {
        failedFiles.push(file);
      }
    } catch (err) {
      failedFiles.push(file);
    }
  }

  // Phase 2: 跨文件边解析
  const resolveResult = resolvePhase(fileResults, config);

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
  for (const edge of resolveResult.resolvedEdges) {
    graph.addEdge(edge);
  }

  // 收集所有节点和边用于构建索引
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  for (const fr of fileResults) {
    allNodes.push(...fr.nodes);
    allEdges.push(...fr.edges);
  }
  allEdges.push(...resolveResult.resolvedEdges);

  // 构建索引
  const symbolIndex = buildSymbolIndex(allNodes);
  const fileIndex = buildFileIndex(allNodes);
  const apiIndex = buildApiIndex(allNodes, allEdges);
  const routeIndex = buildRouteIndex(allNodes, allEdges, config);

  const duration = Date.now() - start;
  const totalRefs = resolveResult.totalRefs;
  const resolvedRefs = totalRefs - resolveResult.unresolvedCount;

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
      unresolvedRefs: resolveResult.unresolvedCount,
      totalRefs,
      resolveRate: totalRefs > 0 ? ((resolvedRefs / totalRefs) * 100).toFixed(1) + '%' : 'N/A',
      duration,
    },
  };
}
