import ts from 'typescript';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import type { ExtractorContext } from './types.js';
import { getLoc } from './types.js';

interface ExtractFunctionsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 函数名 → nodeId 映射，供 extractCalls 确定调用源 */
  functionNodes: Map<string, string>;
}

/**
 * 提取文件中的函数声明
 */
export function extractFunctions(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext
): ExtractFunctionsResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const functionNodes = new Map<string, string>();
  const nameCount = new Map<string, number>();

  const fileNodeId = `file:${ctx.filePath}:${ctx.filePath.split('/').pop()}`;

  function hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  function hasDefaultModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
  }

  function hasAsyncModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    return modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  }

  function isFunctionLike(node: ts.Node): boolean {
    return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  }

  function addFunctionNode(
    name: string,
    node: ts.Node,
    opts: { isAsync?: boolean; isExported?: boolean; isDefaultExport?: boolean } = {}
  ) {
    const count = nameCount.get(name) ?? 0;
    nameCount.set(name, count + 1);
    const uniqueName = count === 0 ? name : `${name}#${count + 1}`;
    const nodeId = `function:${ctx.filePath}:${uniqueName}`;
    const loc = getLoc(sourceFile, node.getStart());
    const isExported = opts.isExported || (ctx.isSetupScript ? isTopLevel(node) : false);

    nodes.push({
      id: nodeId,
      type: 'function',
      name: uniqueName,
      filePath: ctx.filePath,
      loc,
      meta: {
        isAsync: opts.isAsync,
        isExported: isExported || undefined,
        isDefaultExport: opts.isDefaultExport || undefined,
      },
    });
    edges.push({ from: fileNodeId, to: nodeId, type: 'defines', loc });
    functionNodes.set(uniqueName, nodeId);
    // 首个同名函数也用原始名注册，方便 extractCalls 查找
    if (count === 0) {
      functionNodes.set(name, nodeId);
    }
  }

  function isTopLevel(node: ts.Node): boolean {
    let current = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) ||
          ts.isArrowFunction(current) ||
          ts.isFunctionExpression(current) ||
          ts.isMethodDeclaration(current) ||
          ts.isClassDeclaration(current)) {
        return false;
      }
      if (current === sourceFile) return true;
      current = current.parent;
    }
    return true;
  }

  function visit(node: ts.Node) {
    // function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name) {
      addFunctionNode(node.name.text, node, {
        isAsync: hasAsyncModifier(node),
        isExported: hasExportModifier(node),
        isDefaultExport: hasDefaultModifier(node),
      });
    }
    // const foo = () => {} or const foo = function() {}
    else if (ts.isVariableStatement(node)) {
      const isExported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
          addFunctionNode(decl.name.text, node, {
            isAsync: hasAsyncModifier(decl.initializer),
            isExported,
          });
        }
      }
    }
    // export default function() {} (anonymous)
    else if (ts.isExportAssignment(node) && !node.isExportEquals) {
      if (node.expression && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))) {
        addFunctionNode('default', node, {
          isAsync: hasAsyncModifier(node.expression),
          isExported: true,
          isDefaultExport: true,
        });
      }
    }
    // export default function name() {}
    else if (ts.isFunctionDeclaration(node) && !node.name && hasDefaultModifier(node)) {
      addFunctionNode('default', node, {
        isAsync: hasAsyncModifier(node),
        isExported: true,
        isDefaultExport: true,
      });
    }
    // method in object literal or class
    else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      addFunctionNode(node.name.text, node, {
        isAsync: hasAsyncModifier(node),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges, functionNodes };
}
