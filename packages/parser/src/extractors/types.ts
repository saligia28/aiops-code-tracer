import ts from 'typescript';
import type { GraphNode, GraphEdge, RepoConfig, EdgeType } from '@aiops/shared-types';

/**
 * 单文件解析结果
 */
export interface FileParseResult {
  filePath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
  error?: string;
}

/**
 * 未解析引用 — 在跨文件 resolvePhase 中解析
 */
export interface UnresolvedRef {
  fromNodeId: string;
  refName: string;
  originalName?: string; // import { original as refName }
  refType: 'import' | 'call' | 'usage';
  importSource?: string; // 解析后的文件路径
  loc: string;
}

/**
 * 提取器上下文
 */
export interface ExtractorContext {
  filePath: string;
  config: RepoConfig;
  scriptContent: string;
  isSetupScript: boolean;
}

/**
 * 获取 AST 节点的行列位置（1-based）
 */
export function getLoc(sourceFile: ts.SourceFile, pos: number): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
  return `${line + 1}:${character + 1}`;
}
