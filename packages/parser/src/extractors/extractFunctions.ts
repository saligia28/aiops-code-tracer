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
      // Vue 2 Options API: export default { methods: {...}, computed: {...} }
      if (node.expression && ts.isObjectLiteralExpression(node.expression)) {
        extractOptionsApiMethods(node.expression);
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

  /**
   * Vue 2 Options API: 提取 methods/computed/watch/data 中的函数
   */
  function extractOptionsApiMethods(objLiteral: ts.ObjectLiteralExpression) {
    for (const prop of objLiteral.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) continue;
      const propName = ts.isIdentifier(prop.name ?? ({} as ts.Node))
        ? (prop.name as ts.Identifier).text
        : undefined;
      if (!propName) continue;

      // methods: { foo() {}, bar() {} }
      if (propName === 'methods' && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const method of prop.initializer.properties) {
          if (ts.isMethodDeclaration(method) && ts.isIdentifier(method.name)) {
            addFunctionNode(method.name.text, method, {
              isAsync: hasAsyncModifier(method),
              isExported: true,
            });
          }
          if (ts.isPropertyAssignment(method) && ts.isIdentifier(method.name) && isFunctionLike(method.initializer)) {
            addFunctionNode(method.name.text, method, {
              isAsync: hasAsyncModifier(method.initializer),
              isExported: true,
            });
          }
        }
      }

      // computed: { bar() {}, baz: { get() {}, set() {} } }
      if (propName === 'computed' && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const comp of prop.initializer.properties) {
          if (ts.isMethodDeclaration(comp) && ts.isIdentifier(comp.name)) {
            const compNodeId = `computed:${ctx.filePath}:${comp.name.text}`;
            const loc = getLoc(sourceFile, comp.getStart());
            nodes.push({
              id: compNodeId,
              type: 'computed' as import('@aiops/shared-types').NodeType,
              name: comp.name.text,
              filePath: ctx.filePath,
              loc,
              meta: { isExported: true },
            });
            edges.push({ from: fileNodeId, to: compNodeId, type: 'defines', loc });
            functionNodes.set(comp.name.text, compNodeId);
          }
          if (ts.isPropertyAssignment(comp) && ts.isIdentifier(comp.name)) {
            const compNodeId = `computed:${ctx.filePath}:${comp.name.text}`;
            const loc = getLoc(sourceFile, comp.getStart());
            nodes.push({
              id: compNodeId,
              type: 'computed' as import('@aiops/shared-types').NodeType,
              name: comp.name.text,
              filePath: ctx.filePath,
              loc,
              meta: { isExported: true },
            });
            edges.push({ from: fileNodeId, to: compNodeId, type: 'defines', loc });
            functionNodes.set(comp.name.text, compNodeId);
          }
        }
      }

      // watch: { 'x.y': handler, z(newVal) {} }
      if (propName === 'watch' && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        for (const watcher of prop.initializer.properties) {
          let watcherName: string | undefined;
          if (ts.isMethodDeclaration(watcher) && ts.isIdentifier(watcher.name)) {
            watcherName = watcher.name.text;
          } else if (ts.isPropertyAssignment(watcher)) {
            if (ts.isIdentifier(watcher.name)) {
              watcherName = watcher.name.text;
            } else if (ts.isStringLiteral(watcher.name)) {
              watcherName = watcher.name.text;
            }
          }
          if (watcherName) {
            const watcherNodeId = `watcher:${ctx.filePath}:watch_${watcherName}`;
            const loc = getLoc(sourceFile, watcher.getStart());
            nodes.push({
              id: watcherNodeId,
              type: 'watcher' as import('@aiops/shared-types').NodeType,
              name: `watch_${watcherName}`,
              filePath: ctx.filePath,
              loc,
            });
            edges.push({ from: fileNodeId, to: watcherNodeId, type: 'defines', loc });
          }
        }
      }

      // data() { return {...} } — extract top-level data keys as variable nodes
      if (propName === 'data' && ts.isMethodDeclaration(prop)) {
        // data 方法本身作为 function 节点已经在上面被提取，这里不再重复
      }
    }
  }

  visit(sourceFile);
  return { nodes, edges, functionNodes };
}
