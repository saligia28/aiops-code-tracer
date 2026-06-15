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
 * 本文件声明的类型 — 供 Pass2 建 typeRegistry（FQN→节点）。
 *
 * 在中间态携带 fqn↔nodeId，避免 Pass2 从不透明的 node.id 里反解 FQN（约束 2）。
 */
export interface JavaDeclaredType {
  fqn: string;        // 完全限定名，如 com.foo.UserServiceImpl
  simpleName: string; // 简单名，如 UserServiceImpl
  nodeId: string;     // 对应 class/interface 节点 id
  nodeType: 'class' | 'interface'; // 区分类/接口（enum 归 class），供 Pass2 injects 实现解析
  /** 显式 Spring bean 名（来自 @Service("x")/@Component("x") 等的字符串参数）；供 @Qualifier 精确匹配 */
  beanName?: string;
  /** 是否为抽象类（不可实例化，不应作为唯一注入实现） */
  isAbstract?: boolean;
}

/**
 * Java 单文件解析携带的中间数据
 */
export interface JavaParserData {
  /** 本文件的 package（默认包为空串），供 Pass2 同包消解 */
  package: string;
  /** 本文件声明的类型（class/interface/enum），供 Pass2 建 typeRegistry */
  declaredTypes: JavaDeclaredType[];
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
