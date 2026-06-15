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
        // 声明级注入：字段 → 声明类型节点（不做接口→实现求解）
        const targetFqn = resolveTypeFqn(ref.declaredType, importTable, filePackage, registry);
        const toId = targetFqn ? registry.fqnToNode.get(targetFqn) : undefined;
        if (toId) {
          resolvedEdges.push({
            from: ref.fromFieldNodeId,
            to: toId,
            type: 'injects',
            loc: ref.loc,
            meta: {
              confidence: 'medium',
              declaredType: targetFqn,
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
