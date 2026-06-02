/**
 * Java 解析中间态类型 — parser 私有
 *
 * 仅类型/纯函数，不含任何 Java 解析逻辑（解析在 Task 1.11+ 实现）。
 * 这些结构在 Pass1/Pass2 之间携带尚未消解的引用与类型环境。
 */

/**
 * 待消解引用 — Pass1 收集，Pass2（typeRegistry）消解
 *
 * - extends/implements: 类型继承/实现关系，按目标类型名待查
 * - inject: 字段注入点，按声明类型（可带 @Qualifier）待查
 */
export type JavaPendingRef =
  | { kind: 'extends' | 'implements'; fromTypeFQN: string; targetTypeName: string; loc: string }
  | { kind: 'inject'; fromFieldNodeId: string; declaredType: string; qualifier?: string; loc: string };

/**
 * Java 单文件解析携带的中间数据
 */
export interface JavaParserData {
  pendingRefs: JavaPendingRef[];
  typeEnv: {
    importTable: Record<string, string>;          // 短名 → FQN
    fieldTypes: Record<string, string>;            // 字段名 → 声明类型(raw)
    localVarTypes: Record<string, Record<string, string>>; // methodNodeId → (varName → type)  [Phase2 填充]
  };
}

/** 剥泛型/数组，保留 raw type；inner 由调用方按需取 */
export function rawType(t: string): string {
  return t.replace(/<.*>/g, '').replace(/\[\]/g, '').trim();
}
