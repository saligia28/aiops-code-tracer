import ts from 'typescript';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import type { ExtractorContext } from './types.js';
import { getLoc } from './types.js';

const REACTIVE_WRAPPERS = new Set(['ref', 'reactive', 'shallowRef', 'shallowReactive', 'computed', 'toRef', 'toRefs']);
const REF_TYPES = new Set(['ref', 'shallowRef', 'toRef', 'toRefs']);
const REACTIVE_TYPES = new Set(['reactive', 'shallowReactive']);

interface ExtractAssignmentsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * 提取文件中的变量声明（跳过函数赋值，避免与 extractFunctions 重复）
 */
export function extractAssignments(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext,
  functionNodes: Map<string, string>
): ExtractAssignmentsResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nameCount = new Map<string, number>();

  const fileNodeId = `file:${ctx.filePath}:${ctx.filePath.split('/').pop()}`;

  function hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  function isFunctionLike(node: ts.Node): boolean {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  }

  function isTopLevel(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) ||
          ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current)) {
        return false;
      }
      if (current === sourceFile) return true;
      current = current.parent;
    }
    return true;
  }

  function getReactiveType(initializer: ts.Expression): 'ref' | 'reactive' | undefined {
    if (!ts.isCallExpression(initializer)) return undefined;
    const expr = initializer.expression;
    if (!ts.isIdentifier(expr)) return undefined;
    const fnName = expr.text;
    if (!REACTIVE_WRAPPERS.has(fnName)) return undefined;
    if (REF_TYPES.has(fnName)) return 'ref';
    if (REACTIVE_TYPES.has(fnName)) return 'reactive';
    // computed 归类为 ref
    if (fnName === 'computed') return 'ref';
    return undefined;
  }

  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) {
      const isExported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        // 跳过函数赋值（已在 extractFunctions 中处理）
        if (decl.initializer && isFunctionLike(decl.initializer)) continue;
        // 跳过已在 functionNodes 中注册的（保险）
        if (functionNodes.has(decl.name.text)) continue;

        const name = decl.name.text;
        const count = nameCount.get(name) ?? 0;
        nameCount.set(name, count + 1);
        const uniqueName = count === 0 ? name : `${name}#${count + 1}`;
        const loc = getLoc(sourceFile, decl.getStart());
        const nodeId = `variable:${ctx.filePath}:${uniqueName}`;
        const reactiveType = decl.initializer ? getReactiveType(decl.initializer) : undefined;
        const shouldExport = isExported || (ctx.isSetupScript && isTopLevel(node));

        nodes.push({
          id: nodeId,
          type: 'variable',
          name: uniqueName,
          filePath: ctx.filePath,
          loc,
          meta: {
            isExported: shouldExport || undefined,
            reactiveType,
          },
        });
        edges.push({ from: fileNodeId, to: nodeId, type: 'defines', loc });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges };
}
