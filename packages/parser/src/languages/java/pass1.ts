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
 * 解析 import 声明：填充 importTable（供 Pass2 FQN 补全）并产出 import 节点。
 *
 * 文本解析而非依赖 grammar 细节，覆盖四种形态：
 * - 普通      `import com.bar.A;`        → importTable['A'] = 'com.bar.A'
 * - wildcard  `import com.baz.*;`        → importTable['com.baz.*'] = 'com.baz.*'（原样，Pass2 识别 .* 后缀）
 * - static    `import static com.q.U.f;` → importTable['f'] = 'com.q.U.f'
 * - static *  `import static com.q.U.*;` → importTable['com.q.U.*'] = 'com.q.U.*'
 */
function extractImports(root: Node, filePath: string, importTable: Record<string, string>): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const decl of root.namedChildren) {
    if (decl?.type !== 'import_declaration') continue;
    const body = decl.text.replace(/^import\s+/, '').replace(/;\s*$/, '').trim();
    const isStatic = /^static\b/.test(body);
    const qualified = body.replace(/^static\s+/, '').trim();
    const simpleName = qualified.split('.').pop() ?? qualified;

    if (qualified.endsWith('.*')) {
      importTable[qualified] = qualified;
    } else {
      importTable[simpleName] = qualified;
    }

    nodes.push({
      id: `import:${filePath}:${qualified}`,
      type: 'import',
      name: simpleName,
      filePath,
      loc: loc(decl),
      ...(isStatic ? { meta: { isStatic: true } } : {}),
    });
  }
  return nodes;
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
  nodes.push(...extractImports(root, filePath, parserData.typeEnv.importTable));

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
