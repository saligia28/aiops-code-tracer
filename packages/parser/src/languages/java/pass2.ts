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
import { asJavaData, buildTypeRegistry, resolveTypeFqn } from './typeResolver.js';
import type { TypeRegistry } from './typeResolver.js';
import { buildInheritanceMaps } from './methodTable.js';
import type { InheritanceMaps } from './methodTable.js';

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
  const resolvedEdges: GraphEdge[] = [];
  let unresolvedCount = 0;
  let totalRefs = 0;

  for (const fr of ownResults) {
    const data = asJavaData(fr);
    if (!data) continue;
    const { importTable } = data.typeEnv;
    const filePackage = data.package;

    for (const ref of data.pendingRefs) {
      totalRefs++;

      if (ref.kind === 'inject') {
        // 注入：声明类型 → 实现解析（接口→唯一实现/Qualifier/多实现；具体类直连）
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

  return { resolvedEdges, unresolvedCount, totalRefs };
}
