/**
 * Java Pass1 — 单文件结构提取
 *
 * 用 tree-sitter 解析单个 .java 文件，产出文件级图谱节点/边与
 * 跨文件消解所需的中间态（JavaParserData）。Pass2（Task 1.17）负责
 * 用各文件的 pendingRefs + typeEnv 连出 extends/implements/injects 边。
 *
 * 当前覆盖：package、class。后续 task 渐进补全 import/interface/enum/
 * field/method/route。
 */
import path from 'path';
import type { Node } from 'web-tree-sitter';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import type { FileParseResult } from '../../extractors/types.js';
import type { ParserContext } from '../types.js';
import type { JavaParserData } from './types.js';
import { loadJavaParser } from './treeSitter.js';

/** tree-sitter 0-based 行列 → 项目统一的 1-based "行:列" */
function loc(node: Node): string {
  return `${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
}

/** 文件节点（每个文件必有，ID 与 TS parser 保持同构） */
function buildFileNode(filePath: string): GraphNode {
  const fileName = path.basename(filePath);
  return { id: `file:${filePath}:${fileName}`, type: 'file', name: fileName, filePath, loc: '1:1' };
}

/** 空的中间态（pendingRefs/typeEnv 由后续 task 填充） */
function emptyParserData(): JavaParserData {
  return { pendingRefs: [], typeEnv: { importTable: {}, fieldTypes: {}, localVarTypes: {} } };
}

/** 取 package 声明的包名；无 package 声明（默认包）返回空串 */
function extractPackage(root: Node): string {
  const decl = root.namedChildren.find((c) => c?.type === 'package_declaration');
  if (!decl) return '';
  const name = decl.namedChildren.find(
    (c) => c?.type === 'identifier' || c?.type === 'scoped_identifier'
  );
  return name?.text ?? '';
}

/**
 * 单文件 Pass1 解析入口。
 */
export async function runPass1(
  filePath: string,
  content: string,
  _ctx: ParserContext
): Promise<FileParseResult> {
  const fileNode = buildFileNode(filePath);
  const parserData = emptyParserData();

  const parser = await loadJavaParser();
  const tree = parser.parse(content);
  if (!tree) {
    return {
      filePath,
      parserId: 'java',
      nodes: [fileNode],
      edges: [],
      unresolvedRefs: [],
      parserData,
      error: 'PARSE_FAILED',
    };
  }

  const root = tree.rootNode;
  const nodes: GraphNode[] = [fileNode];
  const edges: GraphEdge[] = [];

  const packageName = extractPackage(root);

  for (const cd of root.descendantsOfType('class_declaration')) {
    const nameNode = cd.childForFieldName('name');
    if (!nameNode) continue;
    const className = nameNode.text;
    const fqn = packageName ? `${packageName}.${className}` : className;
    nodes.push({
      id: `class:${filePath}:${fqn}`,
      type: 'class',
      name: className,
      filePath,
      loc: loc(cd),
      ...(packageName ? { meta: { package: packageName } } : {}),
    });
  }

  return { filePath, parserId: 'java', nodes, edges, unresolvedRefs: [], parserData };
}
