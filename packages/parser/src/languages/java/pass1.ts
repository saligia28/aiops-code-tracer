/**
 * Java Pass1 — 单文件结构提取
 *
 * 用 tree-sitter 解析单个 .java 文件，产出文件级图谱节点/边与
 * 跨文件消解所需的中间态（JavaParserData）。Pass2（Task 1.17）负责
 * 用各文件的 pendingRefs + typeEnv 连出 extends/implements/injects 边。
 *
 * 当前覆盖：package、import、class/interface/enum（含注解/stereotype/
 * extends/implements）、field（含注入点）、method（重载安全签名）、
 * Spring route（routeEntry + registersRoute）。
 */
import path from 'path';
import type { Node } from 'web-tree-sitter';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import type { FileParseResult } from '../../extractors/types.js';
import type { ParserContext } from '../types.js';
import type { JavaParserData, JavaPendingRef } from './types.js';
import { rawType } from './types.js';
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

/** 空的中间态（各字段在解析过程中填充） */
function emptyParserData(): JavaParserData {
  return {
    package: '',
    declaredTypes: [],
    pendingRefs: [],
    typeEnv: { importTable: {}, fieldTypes: {}, localVarTypes: {} },
  };
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

/** Spring stereotype 注解（用于显式 bean 名提取） */
const STEREOTYPE_ANNOTATIONS = ['RestController', 'Controller', 'Service', 'Repository', 'Component'];

/** 显式 bean 名：取首个带字符串参数的 stereotype 注解值（如 @Service("x") → 'x'） */
function extractBeanName(decl: Node): string | undefined {
  for (const ann of STEREOTYPE_ANNOTATIONS) {
    const v = annotationArg(decl, ann);
    if (v) return v;
  }
  return undefined;
}

/**
 * 提取 class / interface / enum 声明：
 * - class/enum → 'class' 节点（enum 带 meta.kind='enum'）；interface → 'interface' 节点
 * - 注解、Spring stereotype、package 写入 meta
 * - extends/implements 记为 JavaPendingRef（Pass2 消解）
 * - 显式 bean 名 / abstract 标记记入 declaredTypes（供 Pass2 injects 实现解析）
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
    const beanName = isInterface ? undefined : extractBeanName(decl);
    const isAbstract =
      !isInterface &&
      /\babstract\b/.test(decl.namedChildren.find((c) => c?.type === 'modifiers')?.text ?? '');

    const meta: NodeMeta = {};
    if (packageName) meta.package = packageName;
    if (annotations.length) meta.annotations = annotations;
    if (stereotype) meta.springStereotype = stereotype;
    if (isEnum) meta.kind = 'enum';

    const nodeId = `${nodeType}:${filePath}:${fqn}`;
    nodes.push({
      id: nodeId,
      type: nodeType,
      name: simpleName,
      filePath,
      loc: loc(decl),
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    data.declaredTypes.push({
      fqn,
      simpleName,
      nodeId,
      nodeType,
      ...(beanName ? { beanName } : {}),
      ...(isAbstract ? { isAbstract: true } : {}),
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

type Visibility = NonNullable<NodeMeta['visibility']>;

/** 由 modifiers 文本判定可见性（无显式修饰符 → package-private） */
function visibilityOf(modifiers: Node | undefined): Visibility {
  const text = modifiers?.text ?? '';
  if (/\bpublic\b/.test(text)) return 'public';
  if (/\bprivate\b/.test(text)) return 'private';
  if (/\bprotected\b/.test(text)) return 'protected';
  return 'package';
}

/** 取某注解的首个字符串参数值（去引号），如 @Qualifier("primary") → 'primary' */
function annotationArg(decl: Node, annName: string): string | undefined {
  const modifiers = decl.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return undefined;
  for (const m of modifiers.namedChildren) {
    if (m?.type !== 'annotation') continue;
    if (m.childForFieldName('name')?.text !== annName) continue;
    const args = m.childForFieldName('arguments');
    const lit = args?.descendantsOfType('string_literal')[0];
    if (lit) return lit.text.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** 最近的外层类型声明（class/interface/enum），用于归属字段/方法 */
function enclosingTypeDecl(node: Node): Node | null {
  let cur = node.parent;
  while (cur) {
    if (TYPE_DECL_KINDS.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

const INJECT_ANNOTATIONS = new Set(['@Autowired', '@Resource', '@Inject']);

/** 已知 DI 容器/集合包装类型 — 注入点取其内层 bean 类型 */
const DI_WRAPPERS = new Set([
  'Provider', 'ObjectProvider', 'Optional',
  'List', 'Set', 'Collection', 'Iterable', 'ArrayList', 'HashSet', 'LinkedList',
]);

/**
 * 注入字段类型归一：剥已知 DI 包装取内层 bean 类型
 * （Provider<T>/Optional<T>/List<T>/T[] → T），其余走 rawType。
 */
function unwrapInjectionType(typeText: string): string {
  const t = typeText.trim();
  const arr = t.match(/^(.+?)\s*\[\]$/);
  if (arr) return rawType(arr[1]);
  const generic = t.match(/^([A-Za-z_$][\w$]*)\s*<(.+)>$/);
  if (generic && DI_WRAPPERS.has(generic[1])) return rawType(generic[2]);
  return rawType(t);
}

/**
 * 提取字段：每个 variable_declarator 产一个 'variable' 节点（meta.kind='field'），
 * 连 owner class/interface 的 defines 边；@Autowired/@Resource/@Inject 字段
 * 额外记 inject pendingRef（带 @Qualifier 值）。填充 typeEnv.fieldTypes。
 */
function extractFields(
  root: Node,
  filePath: string,
  packageName: string,
  data: JavaParserData
): { nodes: GraphNode[]; edges: GraphEdge[]; fieldsByOwner: Map<string, Map<string, string>> } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  /** ownerFQN → (fieldName → fieldNodeId)，供构造注入按形参名匹配字段 */
  const fieldsByOwner = new Map<string, Map<string, string>>();

  for (const fd of root.descendantsOfType('field_declaration')) {
    const owner = enclosingTypeDecl(fd);
    if (!owner) continue;
    const ownerFQN = computeTypeFQN(owner, packageName);
    const ownerNodeType = owner.type === 'interface_declaration' ? 'interface' : 'class';
    const ownerId = `${ownerNodeType}:${filePath}:${ownerFQN}`;

    const modifiers = fd.namedChildren.find((c) => c?.type === 'modifiers');
    const annotations = extractAnnotations(fd);
    const visibility = visibilityOf(modifiers);
    const isStatic = /\bstatic\b/.test(modifiers?.text ?? '');
    const typeText = fd.childForFieldName('type')?.text ?? '';
    // 字段真实声明类型（容器保留），用于 meta + receiver 推断
    const fieldType = rawType(typeText);
    // 注入点类型：剥已知 DI 容器/集合包装取内层 bean（Provider<T>/List<T>/T[] → T）
    const injectType = unwrapInjectionType(typeText);
    const isInject = annotations.some((a) => INJECT_ANNOTATIONS.has(a));
    // 注入限定符：@Qualifier("x") / @Resource(name="x") / @Named("x") 任一
    const qualifier = isInject
      ? annotationArg(fd, 'Qualifier') ?? annotationArg(fd, 'Resource') ?? annotationArg(fd, 'Named')
      : undefined;

    for (const vd of fd.namedChildren) {
      if (vd?.type !== 'variable_declarator') continue;
      const nameNode = vd.childForFieldName('name');
      if (!nameNode) continue;
      const fieldName = nameNode.text;
      const fieldId = `variable:${filePath}:${ownerFQN}#${fieldName}`;
      const fieldLoc = loc(vd);

      const meta: NodeMeta = { kind: 'field', ownerType: ownerFQN, visibility };
      if (fieldType) meta.fieldType = fieldType;
      if (isStatic) meta.isStatic = true;
      if (annotations.length) meta.annotations = annotations;

      nodes.push({ id: fieldId, type: 'variable', name: fieldName, filePath, loc: fieldLoc, meta });
      edges.push({ from: ownerId, to: fieldId, type: 'defines', loc: fieldLoc });

      const ownerFields = fieldsByOwner.get(ownerFQN) ?? new Map<string, string>();
      ownerFields.set(fieldName, fieldId);
      fieldsByOwner.set(ownerFQN, ownerFields);

      if (fieldType) data.typeEnv.fieldTypes[fieldName] = fieldType;

      if (isInject && injectType) {
        data.pendingRefs.push({
          kind: 'inject',
          fromFieldNodeId: fieldId,
          declaredType: injectType,
          ...(qualifier ? { qualifier } : {}),
          loc: fieldLoc,
        });
      }
    }
  }

  return { nodes, edges, fieldsByOwner };
}

/**
 * 解析构造器体内 `this.FIELD = PARAM` 赋值，返回 `形参名 → 字段名` 映射，
 * 用于覆盖字段名 ≠ 形参名 的注入（如 `this.barService = bar`）。
 */
function parseCtorFieldAssignments(ctor: Node): Map<string, string> {
  const paramToField = new Map<string, string>();
  const body = ctor.childForFieldName('body');
  if (!body) return paramToField;
  for (const assign of body.descendantsOfType('assignment_expression')) {
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || right?.type !== 'identifier') continue;
    let fieldName: string | undefined;
    if (left.type === 'field_access' && left.childForFieldName('object')?.type === 'this') {
      fieldName = left.childForFieldName('field')?.text;
    } else if (left.type === 'identifier') {
      fieldName = left.text;
    }
    if (fieldName) paramToField.set(right.text, fieldName);
  }
  return paramToField;
}

/**
 * 构造注入：@Autowired/@Inject 构造器，或唯一构造器（Spring 4.3+ 隐式）的每个形参，
 * 连到其赋值目标字段（先按 `this.field=param` 赋值，再回退同名字段），
 * 记一条 inject pendingRef（字段 → 形参声明类型），复用 Pass2 解析。
 */
function extractConstructorInjections(
  root: Node,
  packageName: string,
  fieldsByOwner: Map<string, Map<string, string>>,
  data: JavaParserData
): void {
  const ctorsByOwner = new Map<string, Node[]>();
  for (const ctor of root.descendantsOfType('constructor_declaration')) {
    const owner = enclosingTypeDecl(ctor);
    if (!owner) continue;
    const ownerFQN = computeTypeFQN(owner, packageName);
    const arr = ctorsByOwner.get(ownerFQN) ?? [];
    arr.push(ctor);
    ctorsByOwner.set(ownerFQN, arr);
  }

  for (const [ownerFQN, ctors] of ctorsByOwner) {
    const fields = fieldsByOwner.get(ownerFQN);
    if (!fields || fields.size === 0) continue;

    for (const ctor of ctors) {
      const annotations = extractAnnotations(ctor);
      const annotated = annotations.some((a) => a === '@Autowired' || a === '@Inject');
      const paramsNode = ctor.childForFieldName('parameters');
      const params = paramsNode
        ? paramsNode.namedChildren.filter(
            (p): p is Node => p?.type === 'formal_parameter'
          )
        : [];
      // 注入条件：注解构造器，或唯一构造器且有参数（Spring 4.3+ 隐式）
      if (!annotated && !(ctors.length === 1 && params.length > 0)) continue;

      const paramToField = parseCtorFieldAssignments(ctor);
      for (const p of params) {
        const pName = p.childForFieldName('name')?.text;
        const pType = unwrapInjectionType(p.childForFieldName('type')?.text ?? '');
        if (!pName || !pType) continue;
        // 先按 this.field=param 赋值定位字段，再回退同名字段
        const fieldId = fields.get(paramToField.get(pName) ?? pName);
        if (!fieldId) continue; // 无匹配字段 → 不连
        const qualifier = annotationArg(p, 'Qualifier') ?? annotationArg(p, 'Named');
        data.pendingRefs.push({
          kind: 'inject',
          fromFieldNodeId: fieldId,
          declaredType: pType,
          ...(qualifier ? { qualifier } : {}),
          loc: loc(ctor),
        });
      }
    }
  }
}

/** 常见 java.lang 隐式类型 — 用于方法签名 FQN 归一化（保证重载 ID 稳定可读） */
const JAVA_LANG_TYPES = new Set([
  'String', 'Long', 'Integer', 'Boolean', 'Object', 'Double', 'Float', 'Short',
  'Byte', 'Character', 'Number', 'Void', 'CharSequence', 'Class', 'Iterable',
  'Runnable', 'Thread', 'Exception', 'RuntimeException', 'Throwable',
]);

/** 参数类型归一化：剥泛型/数组后，java.lang 隐式类型补全 FQN，其余保留简单名 */
function normalizeParamType(raw: string): string {
  const r = rawType(raw);
  return JAVA_LANG_TYPES.has(r) ? `java.lang.${r}` : r;
}

/** 取方法/构造器形参类型列表（归一化） */
function paramTypesOf(decl: Node): string[] {
  const params = decl.childForFieldName('parameters');
  if (!params) return [];
  const types: string[] = [];
  for (const p of params.namedChildren) {
    if (p?.type !== 'formal_parameter' && p?.type !== 'spread_parameter') continue;
    types.push(normalizeParamType(p.childForFieldName('type')?.text ?? ''));
  }
  return types;
}

/** Spring 方法级映射注解 → HTTP 方法 */
const METHOD_MAPPING: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/** 在声明节点的 modifiers 中找首个 Spring 映射注解（@*Mapping / @RequestMapping） */
function mappingAnnotation(decl: Node): Node | null {
  const modifiers = decl.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return null;
  for (const m of modifiers.namedChildren) {
    if (m?.type !== 'marker_annotation' && m?.type !== 'annotation') continue;
    const name = m.childForFieldName('name')?.text ?? '';
    if (name === 'RequestMapping' || name in METHOD_MAPPING) return m;
  }
  return null;
}

/** 取映射注解的路径（首个字符串字面量，去引号；无则空串） */
function annotationPath(ann: Node): string {
  const lit = ann.descendantsOfType('string_literal')[0];
  return lit ? lit.text.replace(/^["']|["']$/g, '') : '';
}

/** 取 @RequestMapping(method = RequestMethod.X) 中的 HTTP 方法名 */
function annotationMethod(ann: Node): string | undefined {
  const match = ann.text.match(/RequestMethod\s*\.\s*(\w+)/);
  return match ? match[1].toUpperCase() : undefined;
}

/** 类级基路径（来自类上的 @RequestMapping/@*Mapping），无则空串 */
function basePathOf(typeDecl: Node): string {
  const ann = mappingAnnotation(typeDecl);
  return ann ? annotationPath(ann) : '';
}

/** 方法级映射 → {httpMethod, path}；非路由方法返回 null */
function methodMapping(decl: Node): { httpMethod: string; path: string } | null {
  const ann = mappingAnnotation(decl);
  if (!ann) return null;
  const name = ann.childForFieldName('name')?.text ?? '';
  if (name === 'RequestMapping') {
    return { httpMethod: annotationMethod(ann) ?? 'GET', path: annotationPath(ann) };
  }
  return { httpMethod: METHOD_MAPPING[name] ?? 'GET', path: annotationPath(ann) };
}

/** 合成并规范化路由路径（折叠重复/尾斜杠，保留 {id} 占位符） */
function joinPath(base: string, path: string): string {
  const parts = `${base}/${path}`.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * 收集方法/构造器的局部类型环境：形参 + 方法体局部变量声明（raw 类型）。
 * 供 Pass2 calls 求解推断 receiver 类型。
 * 注：lambda/匿名类内的局部声明会一并归到外层方法（Phase 2 暂不细分作用域）。
 */
function collectLocalVarTypes(decl: Node): Record<string, string> {
  const vars: Record<string, string> = {};

  const params = decl.childForFieldName('parameters');
  if (params) {
    for (const p of params.namedChildren) {
      if (p?.type !== 'formal_parameter' && p?.type !== 'spread_parameter') continue;
      const name = p.childForFieldName('name')?.text;
      const type = rawType(p.childForFieldName('type')?.text ?? '');
      if (name && type) vars[name] = type;
    }
  }

  const body = decl.childForFieldName('body');
  if (body) {
    for (const ld of body.descendantsOfType('local_variable_declaration')) {
      const type = rawType(ld.childForFieldName('type')?.text ?? '');
      if (!type) continue;
      for (const vd of ld.namedChildren) {
        if (vd?.type !== 'variable_declarator') continue;
        const name = vd.childForFieldName('name')?.text;
        if (name) vars[name] = type;
      }
    }
  }

  return vars;
}

/**
 * 收集方法/构造器体内的调用为 call pendingRef（Pass2 求解为 calls 边）。
 * receiverExpr 取接收者原文（无接收者=''、this.x=>'this'、链式=整段表达式）。
 * 不在此处推断 receiver 类型（Pass2 职责）。
 */
function collectCalls(decl: Node, methodNodeId: string): JavaPendingRef[] {
  const body = decl.childForFieldName('body');
  if (!body) return [];
  const refs: JavaPendingRef[] = [];
  for (const inv of body.descendantsOfType('method_invocation')) {
    const nameNode = inv.childForFieldName('name');
    if (!nameNode) continue;
    const object = inv.childForFieldName('object');
    const args = inv.childForFieldName('arguments');
    refs.push({
      kind: 'call',
      fromMethodNodeId: methodNodeId,
      receiverExpr: object?.text ?? '',
      methodName: nameNode.text,
      argCount: args ? args.namedChildren.filter(Boolean).length : 0,
      loc: loc(inv),
    });
  }
  return refs;
}

/**
 * 提取方法/构造器：每个产一个 'function' 节点（meta.kind='method'），id 含
 * 归一化签名 `name(p1,p2)` 以区分重载；连 owner 的 defines 边。
 * 方法级 Spring 映射注解额外产 routeEntry 节点 + registersRoute 边。
 * 不解析方法体调用（Phase 2）。
 */
function extractMethods(
  root: Node,
  filePath: string,
  packageName: string,
  data: JavaParserData
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const decl of root.descendantsOfType(['method_declaration', 'constructor_declaration'])) {
    const owner = enclosingTypeDecl(decl);
    if (!owner) continue;
    const ownerFQN = computeTypeFQN(owner, packageName);
    const ownerNodeType = owner.type === 'interface_declaration' ? 'interface' : 'class';
    const ownerId = `${ownerNodeType}:${filePath}:${ownerFQN}`;

    const nameNode = decl.childForFieldName('name');
    if (!nameNode) continue;
    const name = nameNode.text;
    const paramTypes = paramTypesOf(decl);
    const signature = `${name}(${paramTypes.join(',')})`;
    const methodId = `function:${filePath}:${ownerFQN}#${signature}`;
    const declLoc = loc(decl);

    const modifiers = decl.namedChildren.find((c) => c?.type === 'modifiers');
    const annotations = extractAnnotations(decl);
    const isConstructor = decl.type === 'constructor_declaration';
    const returnType = isConstructor ? '' : rawType(decl.childForFieldName('type')?.text ?? '');

    const meta: NodeMeta = {
      kind: 'method',
      ownerType: ownerFQN,
      visibility: visibilityOf(modifiers),
      signature,
      paramTypes,
    };
    if (returnType) meta.returnType = returnType;
    if (/\bstatic\b/.test(modifiers?.text ?? '')) meta.isStatic = true;
    if (annotations.length) meta.annotations = annotations;

    nodes.push({ id: methodId, type: 'function', name, filePath, loc: declLoc, meta });
    edges.push({ from: ownerId, to: methodId, type: 'defines', loc: declLoc });

    const localVars = collectLocalVarTypes(decl);
    if (Object.keys(localVars).length) data.typeEnv.localVarTypes[methodId] = localVars;

    data.pendingRefs.push(...collectCalls(decl, methodId));

    const mapping = methodMapping(decl);
    if (mapping) {
      const endpoint = joinPath(basePathOf(owner), mapping.path);
      const routeId = `routeEntry:${filePath}:${mapping.httpMethod} ${endpoint}`;
      nodes.push({
        id: routeId,
        type: 'routeEntry',
        name: `${mapping.httpMethod} ${endpoint}`,
        filePath,
        loc: declLoc,
        meta: { apiEndpoint: endpoint, apiMethod: mapping.httpMethod },
      });
      edges.push({ from: routeId, to: methodId, type: 'registersRoute', loc: declLoc });
    }
  }

  return { nodes, edges };
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
  parserData.package = packageName;
  nodes.push(...extractImports(root, filePath, parserData.typeEnv.importTable));
  nodes.push(...extractTypes(root, filePath, packageName, parserData));

  const fields = extractFields(root, filePath, packageName, parserData);
  nodes.push(...fields.nodes);
  edges.push(...fields.edges);

  const methods = extractMethods(root, filePath, packageName, parserData);
  nodes.push(...methods.nodes);
  edges.push(...methods.edges);

  extractConstructorInjections(root, packageName, fields.fieldsByOwner, parserData);

  return { filePath, parserId: 'java', nodes, edges, unresolvedRefs: [], parserData };
}
