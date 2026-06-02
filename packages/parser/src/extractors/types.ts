import ts from 'typescript';
import type { GraphNode, GraphEdge, RepoConfig, EdgeType, LanguageParserId } from '@aiops/shared-types';

/**
 * 单文件解析结果
 */
export interface FileParseResult {
  filePath: string;
  parserId: LanguageParserId;
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
  /** 语言专属中间态（编排层只透传，不检视其结构）。Java: JavaParserData */
  parserData?: unknown;
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
