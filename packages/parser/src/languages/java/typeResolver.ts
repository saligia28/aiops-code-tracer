/**
 * Java 跨文件类型解析 — Pass2 共享内部模块
 *
 * 由各文件 Pass1 的 declaredTypes 建注册表（FQN→节点、简单名→候选），并把
 * 类型引用名消解为 FQN。pass2.ts（连边）与 methodTable.ts（继承/方法表）共用，
 * 避免重复实现。
 */
import type { FileParseResult } from '../../extractors/types.js';
import type { JavaParserData } from './types.js';
import { rawType } from './types.js';

/** 跨文件类型注册表：FQN→节点 id，及简单名→候选 FQN[] */
export interface TypeRegistry {
  fqnToNode: Map<string, string>;
  simpleToFqns: Map<string, string[]>;
  /** FQN → 节点种类（class/interface），供 injects 区分具体类 vs 接口 */
  fqnToNodeType: Map<string, 'class' | 'interface'>;
  /** FQN → 显式 Spring bean 名（@Service("x") 等），供 @Qualifier 精确匹配 */
  fqnToBeanName: Map<string, string>;
  /** FQN → 是否抽象类（不可实例化，不作唯一注入实现） */
  fqnToIsAbstract: Map<string, boolean>;
}

/** 取一个 FileParseResult 的 Java 中间态（非 java 解析结果返回 undefined） */
export function asJavaData(fr: FileParseResult): JavaParserData | undefined {
  return fr.parserId === 'java' ? (fr.parserData as JavaParserData | undefined) : undefined;
}

/** 汇总所有 Java 文件声明的类型，建注册表 */
export function buildTypeRegistry(results: FileParseResult[]): TypeRegistry {
  const fqnToNode = new Map<string, string>();
  const simpleToFqns = new Map<string, string[]>();
  const fqnToNodeType = new Map<string, 'class' | 'interface'>();
  const fqnToBeanName = new Map<string, string>();
  const fqnToIsAbstract = new Map<string, boolean>();

  for (const fr of results) {
    const data = asJavaData(fr);
    if (!data) continue;
    for (const dt of data.declaredTypes) {
      fqnToNode.set(dt.fqn, dt.nodeId);
      fqnToNodeType.set(dt.fqn, dt.nodeType);
      if (dt.beanName) fqnToBeanName.set(dt.fqn, dt.beanName);
      if (dt.isAbstract) fqnToIsAbstract.set(dt.fqn, true);
      const arr = simpleToFqns.get(dt.simpleName) ?? [];
      arr.push(dt.fqn);
      simpleToFqns.set(dt.simpleName, arr);
    }
  }

  return { fqnToNode, simpleToFqns, fqnToNodeType, fqnToBeanName, fqnToIsAbstract };
}

/**
 * 把一个类型引用名消解为 FQN（best-effort），解析顺序：
 * 已限定 → import 表 → 同包 → wildcard import → 唯一简单名候选 → 默认包裸名。
 * 仅返回 FQN 字符串；是否存在对应节点由调用方查 registry 判定。
 */
export function resolveTypeFqn(
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
