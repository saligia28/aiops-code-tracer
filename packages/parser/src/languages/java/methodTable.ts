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
