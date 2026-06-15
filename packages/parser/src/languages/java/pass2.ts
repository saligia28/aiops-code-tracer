/**
 * Java Pass2 — 跨文件连边（Phase 1 范围）
 *
 * 汇总各文件 Pass1 的中间态（JavaParserData）建 typeRegistry，把 pendingRefs
 * 消解为图谱边：
 * - extends / implements：类型继承/实现，置信度 high
 * - injects（声明级）：字段 → 其声明类型节点（不做接口→实现求解），置信度 medium
 *
 * 解析不到目标类型的引用记入 unresolvedCount，不产边。
 * 精确 calls 调用链、接口→实现求解属 Phase 2，不在此处。
 */
import type { GraphEdge } from '@aiops/shared-types';
import type { FileParseResult } from '../../extractors/types.js';
import type { ParserContext, ResolveResult } from '../types.js';
import type { JavaPendingRef } from './types.js';
import { asJavaData, buildTypeRegistry, resolveTypeFqn } from './typeResolver.js';
import type { TypeRegistry } from './typeResolver.js';
import { buildInheritanceMaps, buildMethodTable } from './methodTable.js';
import type { InheritanceMaps } from './methodTable.js';
import { inferReceiverType, selectCallTargets } from './callResolver.js';
import type { ReceiverScope } from './callResolver.js';

type CallRef = Extract<JavaPendingRef, { kind: 'call' }>;

/** 由所有节点建索引：方法节点→owner FQN、字段节点→{owner,name}、owner→字段声明类型 */
interface NodeIndex {
  methodOwnerByNode: Map<string, string>;
  fieldInfoByNode: Map<string, { ownerFQN: string; fieldName: string }>;
  fieldTypesByOwner: Map<string, Map<string, string>>;
}

function buildNodeIndex(ownResults: FileParseResult[]): NodeIndex {
  const methodOwnerByNode = new Map<string, string>();
  const fieldInfoByNode = new Map<string, { ownerFQN: string; fieldName: string }>();
  const fieldTypesByOwner = new Map<string, Map<string, string>>();

  for (const fr of ownResults) {
    if (fr.parserId !== 'java') continue;
    for (const node of fr.nodes) {
      const owner = node.meta?.ownerType;
      if (node.type === 'function' && node.meta?.kind === 'method' && owner) {
        methodOwnerByNode.set(node.id, owner);
      } else if (node.type === 'variable' && node.meta?.kind === 'field' && owner) {
        fieldInfoByNode.set(node.id, { ownerFQN: owner, fieldName: node.name });
        const m = fieldTypesByOwner.get(owner) ?? new Map<string, string>();
        if (node.meta.fieldType) m.set(node.name, node.meta.fieldType);
        fieldTypesByOwner.set(owner, m);
      }
    }
  }

  return { methodOwnerByNode, fieldInfoByNode, fieldTypesByOwner };
}

type Confidence = NonNullable<GraphEdge['meta']>['confidence'];

interface InjectResolution {
  toFqn: string;
  confidence: Confidence;
  reason?: string;
}

/** FQN 的简单名（末段） */
function simpleNameOf(fqn: string): string {
  return fqn.split('.').pop() ?? fqn;
}

/** 首字母小写（Spring 默认 bean 名约定） */
function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * 限定符（@Qualifier / @Resource(name) / @Named）值匹配某个实现：
 * 优先匹配显式 bean 名（@Service("x") 等），否则回退到默认 bean 名约定（类简单名 / 首字母小写）。
 */
function matchQualifier(impls: string[], qualifier: string, registry: TypeRegistry): string | undefined {
  // 1) 显式 bean 名精确匹配（Spring bean 名大小写敏感）
  for (const implFqn of impls) {
    if (registry.fqnToBeanName.get(implFqn) === qualifier) return implFqn;
  }
  // 2) 默认 bean 名约定：类简单名（忽略大小写）/ 首字母小写
  const q = qualifier.toLowerCase();
  for (const implFqn of impls) {
    const simple = simpleNameOf(implFqn);
    if (simple.toLowerCase() === q) return implFqn;
    if (lowerFirst(simple) === qualifier) return implFqn;
  }
  return undefined;
}

/**
 * 声明级注入 → 解析目标（Phase 2）：
 * - 声明类型是接口：唯一实现 high / @Qualifier 命中 medium / 多实现难辨 → 接口节点 low(reason) / 无实现 → 接口节点 medium
 * - 声明类型是具体类（含 enum）：该类节点 high
 * 声明类型无对应节点（外部/未知）→ undefined（计 unresolved）。
 */
function resolveInject(
  declaredFqn: string,
  qualifier: string | undefined,
  registry: TypeRegistry,
  inheritance: InheritanceMaps
): InjectResolution | undefined {
  if (!registry.fqnToNode.has(declaredFqn)) return undefined;

  const isInterface = registry.fqnToNodeType.get(declaredFqn) === 'interface';
  if (!isInterface) {
    return { toFqn: declaredFqn, confidence: 'high' };
  }

  // 抽象类不可实例化，不作为注入实现候选（避免把 high 边指向非实例化 bean）
  const impls = (inheritance.implementsMap.get(declaredFqn) ?? []).filter(
    (fqn) => !registry.fqnToIsAbstract.get(fqn)
  );
  if (impls.length === 1) {
    return { toFqn: impls[0], confidence: 'high' };
  }
  if (impls.length > 1) {
    if (qualifier) {
      const matched = matchQualifier(impls, qualifier, registry);
      if (matched) return { toFqn: matched, confidence: 'medium' };
    }
    return { toFqn: declaredFqn, confidence: 'low', reason: 'multipleImplementations' };
  }
  // 接口但无（具体）实现：退回声明类型节点
  return { toFqn: declaredFqn, confidence: 'medium' };
}

/**
 * Pass2 入口：消解 ownResults 的 pendingRefs。
 * （Phase 1 仅依赖 Java 自身结果；allResults 预留给 Phase 2 跨语言桥。）
 */
export function runPass2(
  ownResults: FileParseResult[],
  _allResults: FileParseResult[],
  _ctx: ParserContext
): ResolveResult {
  const registry = buildTypeRegistry(ownResults);
  const inheritance = buildInheritanceMaps(ownResults);
  const methodTable = buildMethodTable(ownResults, inheritance);
  const { methodOwnerByNode, fieldInfoByNode, fieldTypesByOwner } = buildNodeIndex(ownResults);

  const resolvedEdges: GraphEdge[] = [];
  let unresolvedCount = 0;
  let totalRefs = 0;

  // 注入已解析的 bean：ownerFQN → (fieldName → bean FQN)，供 calls 推断 receiver
  const beansByOwner = new Map<string, Map<string, string>>();
  // calls 延后到 injects 全部解析后再处理（calls receiver 依赖 beansByOwner）
  const callRefs: Array<{
    ref: CallRef;
    importTable: Record<string, string>;
    filePackage: string;
    localVarTypes: Record<string, string>;
  }> = [];

  // —— Pass2a: extends / implements / injects ——
  for (const fr of ownResults) {
    const data = asJavaData(fr);
    if (!data) continue;
    const { importTable } = data.typeEnv;
    const filePackage = data.package;

    for (const ref of data.pendingRefs) {
      if (ref.kind === 'call') {
        callRefs.push({
          ref,
          importTable,
          filePackage,
          localVarTypes: data.typeEnv.localVarTypes[ref.fromMethodNodeId] ?? {},
        });
        continue;
      }
      totalRefs++;

      if (ref.kind === 'inject') {
        const declaredFqn = resolveTypeFqn(ref.declaredType, importTable, filePackage, registry);
        const res = declaredFqn
          ? resolveInject(declaredFqn, ref.qualifier, registry, inheritance)
          : undefined;
        if (declaredFqn && res) {
          resolvedEdges.push({
            from: ref.fromFieldNodeId,
            to: registry.fqnToNode.get(res.toFqn)!,
            type: 'injects',
            loc: ref.loc,
            meta: {
              confidence: res.confidence,
              declaredType: declaredFqn, // 永远记录声明类型 FQN（即便 to 指向实现类）
              ...(res.reason ? { reason: res.reason } : {}),
              ...(ref.qualifier ? { beanQualifier: ref.qualifier } : {}),
            },
          });
          // 记录字段→bean，供 calls receiver 推断
          const fi = fieldInfoByNode.get(ref.fromFieldNodeId);
          if (fi) {
            const m = beansByOwner.get(fi.ownerFQN) ?? new Map<string, string>();
            m.set(fi.fieldName, res.toFqn);
            beansByOwner.set(fi.ownerFQN, m);
          }
        } else {
          unresolvedCount++;
        }
        continue;
      }

      // extends / implements
      const fromId = registry.fqnToNode.get(ref.fromTypeFQN);
      const targetFqn = resolveTypeFqn(ref.targetTypeName, importTable, filePackage, registry);
      const toId = targetFqn ? registry.fqnToNode.get(targetFqn) : undefined;
      if (fromId && toId) {
        resolvedEdges.push({
          from: fromId,
          to: toId,
          type: ref.kind,
          loc: ref.loc,
          meta: { confidence: 'high' },
        });
      } else {
        unresolvedCount++;
      }
    }
  }

  // —— class → bean 注入汇总边（去重；派生自字段注入，不计入 totalRefs）——
  for (const [ownerFQN, fieldBeans] of beansByOwner) {
    const fromId = registry.fqnToNode.get(ownerFQN);
    if (!fromId) continue;
    const seen = new Set<string>();
    for (const beanFqn of fieldBeans.values()) {
      if (seen.has(beanFqn)) continue;
      seen.add(beanFqn);
      const toId = registry.fqnToNode.get(beanFqn);
      if (!toId || toId === fromId) continue;
      resolvedEdges.push({
        from: fromId,
        to: toId,
        type: 'injects',
        meta: { confidence: 'medium', reason: 'aggregateInjection' },
      });
    }
  }

  // —— Pass2b: calls（receiver 推断 + methodTable 匹配）——
  for (const { ref, importTable, filePackage, localVarTypes } of callRefs) {
    totalRefs++;
    const ownerFQN = methodOwnerByNode.get(ref.fromMethodNodeId);
    if (!ownerFQN) {
      unresolvedCount++;
      continue;
    }
    const scope: ReceiverScope = {
      ownerFQN,
      fieldDeclaredTypes: Object.fromEntries(fieldTypesByOwner.get(ownerFQN) ?? new Map()),
      fieldResolvedBeans: Object.fromEntries(beansByOwner.get(ownerFQN) ?? new Map()),
      localVarTypes,
      importTable,
      filePackage,
      registry,
    };
    const receiverFqn = inferReceiverType(ref.receiverExpr, scope);
    const targets = receiverFqn
      ? selectCallTargets(receiverFqn, ref.methodName, ref.argCount, methodTable, registry, inheritance)
      : [];
    if (targets.length === 0) {
      unresolvedCount++;
      continue;
    }
    for (const t of targets) {
      resolvedEdges.push({
        from: ref.fromMethodNodeId,
        to: t.nodeId,
        type: 'calls',
        loc: ref.loc,
        meta: { confidence: t.confidence, ...(t.reason ? { reason: t.reason } : {}) },
      });
    }
  }

  return { resolvedEdges, unresolvedCount, totalRefs };
}
