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
import type { JavaParserData } from './types.js';
import { rawType } from './types.js';

/** 跨文件类型注册表：FQN→节点 id，及简单名→候选 FQN[] */
interface TypeRegistry {
  fqnToNode: Map<string, string>;
  simpleToFqns: Map<string, string[]>;
}

function asJavaData(fr: FileParseResult): JavaParserData | undefined {
  return fr.parserId === 'java' ? (fr.parserData as JavaParserData | undefined) : undefined;
}

/** 汇总所有 Java 文件声明的类型，建注册表 */
function buildTypeRegistry(results: FileParseResult[]): TypeRegistry {
  const fqnToNode = new Map<string, string>();
  const simpleToFqns = new Map<string, string[]>();

  for (const fr of results) {
    const data = asJavaData(fr);
    if (!data) continue;
    for (const dt of data.declaredTypes) {
      fqnToNode.set(dt.fqn, dt.nodeId);
      const arr = simpleToFqns.get(dt.simpleName) ?? [];
      arr.push(dt.fqn);
      simpleToFqns.set(dt.simpleName, arr);
    }
  }

  return { fqnToNode, simpleToFqns };
}

/**
 * 把一个类型引用名消解为 FQN（best-effort），解析顺序：
 * 已限定 → import 表 → 同包 → wildcard import → 唯一简单名候选 → 默认包裸名。
 * 仅返回 FQN 字符串；是否存在对应节点由调用方查 registry 判定。
 */
function resolveTypeFqn(
  name: string,
  importTable: Record<string, string>,
  filePackage: string,
  registry: TypeRegistry
): string | undefined {
  const raw = rawType(name);
  if (!raw) return undefined;

  // 已（部分）限定：直接当 FQN
  if (raw.includes('.')) return raw;

  // 显式 import
  const imported = importTable[raw];
  if (imported) return imported;

  // 同包
  if (filePackage) {
    const samePkg = `${filePackage}.${raw}`;
    if (registry.fqnToNode.has(samePkg)) return samePkg;
  }

  // wildcard import：pkg.* → pkg.raw
  for (const key of Object.keys(importTable)) {
    if (!key.endsWith('.*')) continue;
    const candidate = `${key.slice(0, -2)}.${raw}`;
    if (registry.fqnToNode.has(candidate)) return candidate;
  }

  // 注册表中唯一同名候选
  const candidates = registry.simpleToFqns.get(raw);
  if (candidates && candidates.length === 1) return candidates[0];

  // 默认包：裸名即 FQN
  if (!filePackage && registry.fqnToNode.has(raw)) return raw;

  return undefined;
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
