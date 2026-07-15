import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import type { GraphNode, GraphEdge, RepoConfig } from '@aiops/shared-types';
import { parseVueSfc, parseVueSfcContent } from '../../scanner/vueSfcParser.js';
import { extractImports } from '../../extractors/extractImports.js';
import { extractFunctions } from '../../extractors/extractFunctions.js';
import { extractCalls } from '../../extractors/extractCalls.js';
import { extractAssignments } from '../../extractors/extractAssignments.js';
import type { FileParseResult, UnresolvedRef, ExtractorContext } from '../../extractors/types.js';
import type { LanguageParser, ParserContext, ResolveResult } from '../types.js';

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

/** 构建文件节点（每个文件必有） */
function buildFileNode(filePath: string): GraphNode {
  const fileName = path.basename(filePath);
  return {
    id: `file:${filePath}:${fileName}`,
    type: 'file',
    name: fileName,
    filePath,
    loc: '1:1',
  };
}

/**
 * 提取核心：给定 script 内容运行 4 个 extractor。
 * content 版与读盘版共用此核心，确保两条路径产物一致。
 */
function runExtractors(
  filePath: string,
  fileNode: GraphNode,
  scriptContent: string | null,
  scriptLang: string | null,
  isSetupScript: boolean,
  config: RepoConfig
): FileParseResult {
  if (!scriptContent) {
    return { filePath, parserId: 'typescript', nodes: [fileNode], edges: [], unresolvedRefs: [] };
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
    parserId: 'typescript',
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

/** loc（"行:列"，1-based）整体下移 offset 行；解析不出行号时原样保留。 */
function offsetLoc(loc: string, offset: number): string {
  const sep = loc.indexOf(':');
  const line = Number(sep >= 0 ? loc.slice(0, sep) : loc);
  if (!Number.isFinite(line) || line < 1) return loc;
  return `${line + offset}${sep >= 0 ? loc.slice(sep) : ''}`;
}

/**
 * Vue SFC：extractor 拿到的是 script 块内容，产出的行号是「块内行号」；
 * 这里统一映射回文件行号（+ scriptStartLine - 1），否则所有 SFC 符号的
 * file:line 引用会整体偏移 template 的长度（L2 引用评测抓到的真 bug）。
 * file 节点代表整个文件，不偏移。
 */
function offsetVueScriptLocs(result: FileParseResult, scriptStartLine: number): FileParseResult {
  const offset = scriptStartLine - 1;
  if (offset <= 0) return result;
  return {
    ...result,
    nodes: result.nodes.map((n) => (n.type === 'file' ? n : { ...n, loc: offsetLoc(n.loc, offset) })),
    unresolvedRefs: result.unresolvedRefs.map((r) => ({ ...r, loc: offsetLoc(r.loc, offset) })),
  };
}

/**
 * content 版单文件解析 — 编排层已读取文件内容后调用（LanguageParser.parseFile）。
 * `.vue` 传入的是原始 SFC 文本，由本函数内部提取 `<script>`。
 */
export function parseTypeScriptContent(
  filePath: string,
  content: string,
  config: RepoConfig
): FileParseResult {
  const fileNode = buildFileNode(filePath);
  const ext = path.extname(filePath).toLowerCase();

  let scriptContent: string | null = null;
  let scriptLang: string | null = null;
  let isSetupScript = false;
  let scriptStartLine = 1;

  if (ext === '.vue') {
    try {
      const sfcResult = parseVueSfcContent(content, filePath);
      scriptContent = sfcResult.scriptContent;
      scriptLang = sfcResult.scriptLang;
      isSetupScript = sfcResult.scriptSetup;
      scriptStartLine = sfcResult.scriptStartLine;
    } catch {
      return { filePath, parserId: 'typescript', nodes: [fileNode], edges: [], unresolvedRefs: [], error: 'SFC_PARSE_ERROR' };
    }
  } else {
    scriptContent = content;
  }

  const result = runExtractors(filePath, fileNode, scriptContent, scriptLang, isSetupScript, config);
  return ext === '.vue' ? offsetVueScriptLocs(result, scriptStartLine) : result;
}

/**
 * 读盘版单文件解析 — 向后兼容旧 `parseFile(filePath, config)` 签名与语义。
 * 现有 graphBuilder 测试与 `index.ts` 旧导出经此路径，行为与重构前完全一致。
 */
export function parseFileFromDisk(filePath: string, config: RepoConfig): FileParseResult {
  const fileNode = buildFileNode(filePath);
  const absolutePath = path.join(config.repoPath, filePath);
  const ext = path.extname(filePath).toLowerCase();

  let scriptContent: string | null = null;
  let scriptLang: string | null = null;
  let isSetupScript = false;
  let scriptStartLine = 1;

  if (ext === '.vue') {
    try {
      const sfcResult = parseVueSfc(absolutePath);
      scriptContent = sfcResult.scriptContent;
      scriptLang = sfcResult.scriptLang;
      isSetupScript = sfcResult.scriptSetup;
      scriptStartLine = sfcResult.scriptStartLine;
    } catch {
      return { filePath, parserId: 'typescript', nodes: [fileNode], edges: [], unresolvedRefs: [], error: 'SFC_PARSE_ERROR' };
    }
  } else {
    try {
      scriptContent = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      return { filePath, parserId: 'typescript', nodes: [fileNode], edges: [], unresolvedRefs: [], error: 'FILE_READ_ERROR' };
    }
  }

  const result = runExtractors(filePath, fileNode, scriptContent, scriptLang, isSetupScript, config);
  return ext === '.vue' ? offsetVueScriptLocs(result, scriptStartLine) : result;
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
      const sourceExports = findExportMap(exportMap, matchedImport.sourcePath, config.aliases);
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
        const sourceExports = findExportMap(exportMap, matchedBaseImport.sourcePath, config.aliases);
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

    // 策略2.6: this.$refs.ComponentRef.method() -> 组件文件中的 method
    if (!resolved && ref.refName.startsWith('$refs.')) {
      const refMatch = ref.refName.match(/^\$refs\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
      if (refMatch) {
        const refAlias = refMatch[1];
        const methodName = refMatch[2];
        const matchedRefImport = imports.find((item) => item.localName === refAlias);
        if (matchedRefImport) {
          const sourceExports = findExportMap(exportMap, matchedRefImport.sourcePath, config.aliases);
          if (sourceExports) {
            const targetId = sourceExports.get(methodName);
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
      }
    }

    // 策略3: Vuex 全局节点
    if (!resolved && (ref.refName.startsWith('store.dispatch') || ref.refName.startsWith('store.commit'))) {
      // 提取 action/mutation 名称
      const dispatchMatch = ref.refName.match(/store\.dispatch\(['"`]([^'"`]+)['"`]\)/);
      const commitMatch = ref.refName.match(/store\.commit\(['"`]([^'"`]+)['"`]\)/);
      const actionName = dispatchMatch?.[1] ?? commitMatch?.[1];
      if (actionName) {
        // 在所有文件中查找对应的 vuexAction/vuexMutation 节点
        for (const [, fileMap] of nodesByFile) {
          const targetId = fileMap.get(actionName);
          if (targetId) {
            const targetNode = allNodeMap.get(targetId);
            const expectedType = dispatchMatch ? 'vuexAction' : 'vuexMutation';
            if (!targetNode || targetNode.type !== expectedType) {
              continue;
            }
            const edgeType = dispatchMatch ? 'dispatches' : 'commits';
            resolvedEdges.push({
              from: ref.fromNodeId,
              to: targetId,
              type: edgeType as import('@aiops/shared-types').EdgeType,
              loc: ref.loc,
            });
            resolved = true;
            break;
          }
        }
        // 兜底：在 allNodeMap 中查找名称匹配的 vuex 节点
        if (!resolved) {
          for (const [nodeId, node] of allNodeMap) {
            if ((node.type === 'vuexAction' || node.type === 'vuexMutation') && node.name === actionName) {
              const edgeType = dispatchMatch ? 'dispatches' : 'commits';
              resolvedEdges.push({
                from: ref.fromNodeId,
                to: nodeId,
                type: edgeType as import('@aiops/shared-types').EdgeType,
                loc: ref.loc,
              });
              resolved = true;
              break;
            }
          }
        }
      }
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
 * 支持 @ 别名归一化
 */
function findExportMap(
  exportMap: Map<string, Map<string, string>>,
  sourcePath: string,
  aliases?: Record<string, string>
): Map<string, string> | undefined {
  // 先处理别名归一化
  let normalized = sourcePath;
  if (aliases) {
    for (const [alias, target] of Object.entries(aliases)) {
      const prefix = alias.endsWith('/') ? alias : `${alias}/`;
      if (normalized.startsWith(prefix)) {
        normalized = normalized.replace(prefix, target.endsWith('/') ? target : `${target}/`);
        break;
      }
      if (normalized === alias) {
        normalized = target;
        break;
      }
    }
  }

  // 精确匹配
  let result = exportMap.get(normalized);
  if (result) return result;

  // 尝试添加常见扩展名
  for (const ext of ['.ts', '.js', '.vue', '.tsx', '.jsx']) {
    result = exportMap.get(normalized + ext);
    if (result) return result;
  }

  // 尝试 index 文件
  for (const ext of ['.ts', '.js']) {
    result = exportMap.get(normalized + '/index' + ext);
    if (result) return result;
  }

  // 如果归一化后的路径和原路径不同，也尝试原路径
  if (normalized !== sourcePath) {
    result = exportMap.get(sourcePath);
    if (result) return result;
    for (const ext of ['.ts', '.js', '.vue', '.tsx', '.jsx']) {
      result = exportMap.get(sourcePath + ext);
      if (result) return result;
    }
  }

  return undefined;
}

/**
 * 去掉文件扩展名
 */
function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|js|vue|tsx|jsx)$/, '');
}

/**
 * TypeScript / Vue 语言解析器 — 包装既有 extractor 逻辑为语言无关接口。
 */
export const TypeScriptLanguageParser: LanguageParser = {
  id: 'typescript',
  extensions: ['.vue', '.ts', '.js', '.tsx', '.jsx'],
  parseFile(filePath: string, content: string, ctx: ParserContext): FileParseResult {
    return parseTypeScriptContent(filePath, content, ctx.config);
  },
  resolve(ownResults: FileParseResult[], _allResults: FileParseResult[], ctx: ParserContext): ResolveResult {
    return resolvePhase(ownResults, ctx.config);
  },
};
