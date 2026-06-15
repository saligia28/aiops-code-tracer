/**
 * Java Pass1 — 单文件结构提取
 *
 * 用 tree-sitter 解析单个 .java 文件，产出文件级图谱节点/边与
 * 跨文件消解所需的中间态（JavaParserData）。Pass2（Task 1.17）负责
 * 用各文件的 pendingRefs + typeEnv 连出 extends/implements/injects 边。
 *
 * 当前覆盖：package、import、class/interface/enum（含注解/stereotype/
 * extends/implements）。后续 task 渐进补全 field/method/route。
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

type NodeMeta = NonNullable<GraphNode['meta']>;
type SpringStereotype = NonNullable<NodeMeta['springStereotype']>;

/** 从声明节点的 modifiers 中提取注解名（带 @，不含参数），如 ['@Service', '@RequestMapping'] */
function extractAnnotations(decl: Node): string[] {
  const modifiers = decl.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return [];
  const anns: string[] = [];
  for (const m of modifiers.namedChildren) {
    if (m?.type === 'marker_annotation' || m?.type === 'annotation') {
      const nameNode = m.childForFieldName('name');
      if (nameNode) anns.push(`@${nameNode.text}`);
    }
  }
  return anns;
}

/** 由注解推断 Spring stereotype（取首个命中） */
function inferStereotype(annotations: string[]): SpringStereotype | undefined {
  for (const a of annotations) {
    if (a === '@RestController' || a === '@Controller') return 'controller';
    if (a === '@Service') return 'service';
    if (a === '@Repository' || a === '@Mapper') return 'repository';
    if (a === '@Component') return 'component';
  }
  return undefined;
}

/** 类型声明节点集合（class/interface/enum 三类共用判定） */
const TYPE_DECL_KINDS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
]);

/** 计算类型 FQN：package + 由外到内的声明名链（嵌套类 → Outer.Inner） */
function computeTypeFQN(decl: Node, packageName: string): string {
  const names: string[] = [];
  let cur: Node | null = decl;
  while (cur) {
    if (TYPE_DECL_KINDS.has(cur.type)) {
      const n = cur.childForFieldName('name');
      if (n) names.unshift(n.text);
    }
    cur = cur.parent;
  }
  const simple = names.join('.');
  return packageName ? `${packageName}.${simple}` : simple;
}

/**
 * 从 superclass / super_interfaces / extends_interfaces 容器中取目标类型原文本。
 * superclass 直接挂 type 子节点；super_interfaces/extends_interfaces 内含 type_list。
 */
function typeNamesIn(container: Node | undefined): string[] {
  if (!container) return [];
  const typeList = container.namedChildren.find((c) => c?.type === 'type_list');
  const typeNodes = typeList ? typeList.namedChildren : container.namedChildren;
  return typeNodes.filter((t): t is Node => !!t).map((t) => t.text);
}

/**
 * 提取 class / interface / enum 声明：
 * - class/enum → 'class' 节点（enum 带 meta.kind='enum'）；interface → 'interface' 节点
 * - 注解、Spring stereotype、package 写入 meta
 * - extends/implements 记为 JavaPendingRef（Pass2 消解）
 */
function extractTypes(
  root: Node,
  filePath: string,
  packageName: string,
  data: JavaParserData
): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const decl of root.descendantsOfType([...TYPE_DECL_KINDS])) {
    const nameNode = decl.childForFieldName('name');
    if (!nameNode) continue;

    const simpleName = nameNode.text;
    const fqn = computeTypeFQN(decl, packageName);
    const annotations = extractAnnotations(decl);
    const stereotype = inferStereotype(annotations);

    const isInterface = decl.type === 'interface_declaration';
    const isEnum = decl.type === 'enum_declaration';
    const nodeType = isInterface ? 'interface' : 'class';

    const meta: NodeMeta = {};
    if (packageName) meta.package = packageName;
    if (annotations.length) meta.annotations = annotations;
    if (stereotype) meta.springStereotype = stereotype;
    if (isEnum) meta.kind = 'enum';

    nodes.push({
      id: `${nodeType}:${filePath}:${fqn}`,
      type: nodeType,
      name: simpleName,
      filePath,
      loc: loc(decl),
      ...(Object.keys(meta).length ? { meta } : {}),
    });

    const declLoc = loc(decl);
    if (isInterface) {
      // interface 可 extends 多个父接口
      const ext = decl.namedChildren.find((c) => c?.type === 'extends_interfaces');
      for (const tn of typeNamesIn(ext)) {
        data.pendingRefs.push({ kind: 'extends', fromTypeFQN: fqn, targetTypeName: tn, loc: declLoc });
      }
    } else {
      const superclass = decl.namedChildren.find((c) => c?.type === 'superclass');
      for (const tn of typeNamesIn(superclass)) {
        data.pendingRefs.push({ kind: 'extends', fromTypeFQN: fqn, targetTypeName: tn, loc: declLoc });
      }
      const superInterfaces = decl.namedChildren.find((c) => c?.type === 'super_interfaces');
      for (const tn of typeNamesIn(superInterfaces)) {
        data.pendingRefs.push({ kind: 'implements', fromTypeFQN: fqn, targetTypeName: tn, loc: declLoc });
      }
    }
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
  nodes.push(...extractTypes(root, filePath, packageName, parserData));

  return { filePath, parserId: 'java', nodes, edges, unresolvedRefs: [], parserData };
}
