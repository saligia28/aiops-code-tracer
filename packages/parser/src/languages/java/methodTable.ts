/**
 * Java 继承关系图 + 方法表（Pass2 符号求解基础设施）
 *
 * - InheritanceMaps：extendsMap（子类型 FQN → 父类型 FQN[]）、implementsMap（接口 FQN → 实现类 FQN[]）
 * - methodTable（Task 2.2）：类型 FQN → 方法名 → 候选方法[]，沿继承链合并
 *
 * 输入是各文件 Pass1 的 FileParseResult[]；类型名解析复用 typeResolver。
 */
import type { FileParseResult } from '../../extractors/types.js';
import { asJavaData, buildTypeRegistry, resolveTypeFqn } from './typeResolver.js';

export interface InheritanceMaps {
  /** 子类/子接口 FQN → 父类型 FQN[]（extends） */
  extendsMap: Map<string, string[]>;
  /** 接口 FQN → 实现类 FQN[]（implements，反向汇总） */
  implementsMap: Map<string, string[]>;
}

/** 方法表条目：方法节点 id + 归一化参数类型（区分重载） */
export interface MethodEntry {
  nodeId: string;
  paramTypes: string[];
}

/** 类型 FQN → 方法名 → 候选方法[]（含沿继承链合并来的方法） */
export type MethodTable = Map<string, Map<string, MethodEntry[]>>;

function pushUnique(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) {
    if (!arr.includes(value)) arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * 由各文件的 extends/implements pendingRefs 建继承关系图。
 * 目标类型名经 typeResolver 消解为 FQN；解析不到的关系跳过。
 */
export function buildInheritanceMaps(results: FileParseResult[]): InheritanceMaps {
  const registry = buildTypeRegistry(results);
  const extendsMap = new Map<string, string[]>();
  const implementsMap = new Map<string, string[]>();

  for (const fr of results) {
    const data = asJavaData(fr);
    if (!data) continue;
    const { importTable } = data.typeEnv;
    const filePackage = data.package;

    for (const ref of data.pendingRefs) {
      if (ref.kind !== 'extends' && ref.kind !== 'implements') continue;
      const targetFqn = resolveTypeFqn(ref.targetTypeName, importTable, filePackage, registry);
      if (!targetFqn) continue;

      if (ref.kind === 'extends') {
        pushUnique(extendsMap, ref.fromTypeFQN, targetFqn);
      } else {
        // implements：接口(目标) → 实现类(来源) 的反向汇总
        pushUnique(implementsMap, targetFqn, ref.fromTypeFQN);
      }
    }
  }

  return { extendsMap, implementsMap };
}

/** 收集每个类型自身声明的方法（不含继承） */
function collectOwnMethods(results: FileParseResult[]): MethodTable {
  const own: MethodTable = new Map();
  for (const fr of results) {
    for (const node of fr.nodes) {
      if (node.type !== 'function' || node.meta?.kind !== 'method') continue;
      const owner = node.meta.ownerType;
      if (!owner) continue;
      const byName = own.get(owner) ?? new Map<string, MethodEntry[]>();
      own.set(owner, byName);
      const entries = byName.get(node.name) ?? [];
      entries.push({ nodeId: node.id, paramTypes: node.meta.paramTypes ?? [] });
      byName.set(node.name, entries);
    }
  }
  return own;
}

/** 由继承关系建「类型 → 直接父类型集合」（合并 extends 父类型与所实现接口） */
function buildSuperTypes(maps: InheritanceMaps): Map<string, Set<string>> {
  const superTypes = new Map<string, Set<string>>();
  const add = (child: string, parent: string) => {
    const s = superTypes.get(child) ?? new Set<string>();
    s.add(parent);
    superTypes.set(child, s);
  };
  for (const [child, parents] of maps.extendsMap) for (const p of parents) add(child, p);
  for (const [iface, impls] of maps.implementsMap) for (const impl of impls) add(impl, iface);
  return superTypes;
}

/**
 * 建方法表：每个类型的方法 = 自身方法 ∪ 沿父类型/接口链继承的方法。
 * 子类重写优先（同 `name(paramTypes)` 签名只保留最派生的一个）；防环。
 */
export function buildMethodTable(results: FileParseResult[], maps: InheritanceMaps): MethodTable {
  const own = collectOwnMethods(results);
  const superTypes = buildSuperTypes(maps);

  const allTypes = new Set<string>(own.keys());
  for (const [child, parents] of superTypes) {
    allTypes.add(child);
    for (const p of parents) allTypes.add(p);
  }

  const result: MethodTable = new Map();
  for (const fqn of allTypes) {
    const merged = new Map<string, MethodEntry[]>();
    const sigSeen = new Set<string>(); // 'name(p1,p2)' — 子类先注册 → 屏蔽父类重写
    const visited = new Set<string>();

    const walk = (t: string) => {
      if (visited.has(t)) return;
      visited.add(t);
      const byName = own.get(t);
      if (byName) {
        for (const [name, entries] of byName) {
          for (const e of entries) {
            const sig = `${name}(${e.paramTypes.join(',')})`;
            if (sigSeen.has(sig)) continue;
            sigSeen.add(sig);
            const arr = merged.get(name) ?? [];
            arr.push(e);
            merged.set(name, arr);
          }
        }
      }
      for (const sup of superTypes.get(t) ?? []) walk(sup);
    };

    walk(fqn);
    if (merged.size > 0) result.set(fqn, merged);
  }

  return result;
}
