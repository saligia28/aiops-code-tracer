/**
 * Java calls 求解（Phase 2D）
 *
 * - inferReceiverType：由调用接收者表达式推断其类型 FQN（this/字段/局部变量/链式降级）。
 *   字段优先用注入已解析的实现类型（fieldResolvedBeans），打通"接口字段调用→实现方法"。
 * - selectCallTargets：在 methodTable 上按方法名 + 实参数匹配候选方法，给出目标 + confidence。
 *
 * 纯函数，不触 tree-sitter；输入为 Pass1/Pass2 已构建的中间态。
 */
import type { TypeRegistry } from './typeResolver.js';
import { resolveTypeFqn } from './typeResolver.js';
import type { MethodTable, InheritanceMaps } from './methodTable.js';

type Confidence = 'high' | 'medium' | 'low';

/** receiver 推断所需的作用域（按"当前方法 + 其所属类"组装） */
export interface ReceiverScope {
  /** 调用方法所属类 FQN（this / 无接收者时的类型） */
  ownerFQN: string;
  /** 字段名 → 声明类型（raw 或 FQN 皆可，内部经 resolveTypeFqn 归一） */
  fieldDeclaredTypes: Record<string, string>;
  /** 字段名 → 注入已解析的 bean 类型 FQN（优先于声明类型） */
  fieldResolvedBeans: Record<string, string>;
  /** 当前方法的局部变量/形参名 → 声明类型（raw） */
  localVarTypes: Record<string, string>;
  importTable: Record<string, string>;
  filePackage: string;
  registry: TypeRegistry;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * 推断接收者类型 FQN：
 * '' / 'this' → 当前类；局部变量/形参（遮蔽字段）→ 其声明类型；
 * 字段 → 注入实现优先，否则声明类型；链式/复杂表达式 → undefined（降级）。
 */
export function inferReceiverType(receiverExpr: string, scope: ReceiverScope): string | undefined {
  if (receiverExpr === '' || receiverExpr === 'this') return scope.ownerFQN;
  if (!IDENTIFIER.test(receiverExpr)) return undefined; // a.b().c() 等链式/复杂 → 降级

  const name = receiverExpr;

  // 局部变量/形参遮蔽同名字段
  const localRaw = scope.localVarTypes[name];
  if (localRaw) return resolveTypeFqn(localRaw, scope.importTable, scope.filePackage, scope.registry);

  // 字段：注入实现优先
  const bean = scope.fieldResolvedBeans[name];
  if (bean) return bean;
  const fieldRaw = scope.fieldDeclaredTypes[name];
  if (fieldRaw) return resolveTypeFqn(fieldRaw, scope.importTable, scope.filePackage, scope.registry);

  return undefined;
}

/** calls 候选目标 + 置信度 */
export interface CallTarget {
  nodeId: string;
  confidence: Confidence;
  reason?: string;
}

/** 在某类型的方法表里按方法名 + 实参数挑一个候选（arity 优先，否则首个） */
function pickMethod(
  ownerFqn: string,
  methodName: string,
  argCount: number,
  methodTable: MethodTable
): string | undefined {
  const candidates = methodTable.get(ownerFqn)?.get(methodName);
  if (!candidates || candidates.length === 0) return undefined;
  const arityMatch = candidates.filter((c) => c.paramTypes.length === argCount);
  return (arityMatch[0] ?? candidates[0]).nodeId;
}

/**
 * 在 methodTable 上为一次调用选目标方法：
 * - receiver 为接口且有 >1 个实现：fan-out 到各实现同名方法（Top-N，low，multipleImplementations）。
 * - 否则按方法名 + 实参数（argCount）取候选：唯一 → 接口 medium / 具体类 high；
 *   多候选（同 arity 重载难辨）→ Top-N 条 low，ambiguousOverload。
 * - 无候选：返回空（调用方计 unresolved）。
 */
export function selectCallTargets(
  receiverFqn: string,
  methodName: string,
  argCount: number,
  methodTable: MethodTable,
  registry: TypeRegistry,
  inheritance?: InheritanceMaps,
  topN = 3
): CallTarget[] {
  const isInterface = registry.fqnToNodeType.get(receiverFqn) === 'interface';

  // 接口 + 多实现：fan-out 到各（具体）实现的同名方法（抽象类不可实例化，剔除）
  if (isInterface && inheritance) {
    const impls = (inheritance.implementsMap.get(receiverFqn) ?? []).filter(
      (fqn) => !registry.fqnToIsAbstract.get(fqn)
    );
    if (impls.length > 1) {
      const targets: CallTarget[] = [];
      for (const implFqn of impls.slice(0, topN)) {
        const nodeId = pickMethod(implFqn, methodName, argCount, methodTable);
        if (nodeId) targets.push({ nodeId, confidence: 'low', reason: 'multipleImplementations' });
      }
      if (targets.length > 0) return targets;
      // 各实现都查不到该方法 → 退回接口自身方法（下方逻辑）
    }
  }

  const candidates = methodTable.get(receiverFqn)?.get(methodName);
  if (!candidates || candidates.length === 0) return [];

  const arityMatch = candidates.filter((c) => c.paramTypes.length === argCount);
  const pool = arityMatch.length > 0 ? arityMatch : candidates;
  const baseConfidence: Confidence = isInterface ? 'medium' : 'high';

  if (pool.length === 1) {
    return [{ nodeId: pool[0].nodeId, confidence: baseConfidence }];
  }
  return pool.slice(0, topN).map((c) => ({
    nodeId: c.nodeId,
    confidence: 'low' as Confidence,
    reason: 'ambiguousOverload',
  }));
}
