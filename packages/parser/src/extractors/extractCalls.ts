import ts from 'typescript';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import type { ExtractorContext, UnresolvedRef } from './types.js';
import { getLoc } from './types.js';

const API_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);
const API_CALLERS = new Set(['axios', 'request', 'http', '$http']);

interface ExtractCallsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
}

/**
 * 提取文件中的函数调用
 */
export function extractCalls(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext,
  functionNodes: Map<string, string>
): ExtractCallsResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];
  const apiCallCount = new Map<string, number>();

  const fileNodeId = `file:${ctx.filePath}:${ctx.filePath.split('/').pop()}`;

  /**
   * 生成去重后的 API call 节点 ID
   */
  function uniqueApiCallId(baseId: string): string {
    const count = apiCallCount.get(baseId) ?? 0;
    apiCallCount.set(baseId, count + 1);
    return count === 0 ? baseId : `${baseId}#${count + 1}`;
  }

  /**
   * 查找当前 CallExpression 所属的最近函数节点
   */
  function findEnclosingFunction(node: ts.Node): string | null {
    let current = node.parent;
    while (current && current !== sourceFile) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        return functionNodes.get(current.name.text) ?? null;
      }
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
        const fnId = functionNodes.get(current.name.text);
        if (fnId) return fnId;
      }
      if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) {
        return functionNodes.get(current.name.text) ?? null;
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * 从 CallExpression 的第一个参数提取字符串字面量（用于 API endpoint）
   */
  function extractFirstStringArg(node: ts.CallExpression): string | undefined {
    if (node.arguments.length === 0) return undefined;
    const first = node.arguments[0];
    if (ts.isStringLiteral(first)) return first.text;
    if (ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
    if (ts.isTemplateExpression(first)) return first.head.text + '...';
    return undefined;
  }

  function visit(node: ts.Node) {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const loc = getLoc(sourceFile, node.getStart());
    const fromNodeId = findEnclosingFunction(node) ?? fileNodeId;

    // axios.get('/api/xxx') 或 request.post('/api/xxx')
    if (ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const method = node.expression.name.text;

      // 检测 API 调用模式: axios.get, this.$http.post, request.delete 等
      if (API_METHODS.has(method.toLowerCase())) {
        let isApiCall = false;
        if (ts.isIdentifier(obj) && API_CALLERS.has(obj.text)) {
          isApiCall = true;
        }
        // this.$http.get 或 this.axios.get
        if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const propName = obj.name.text;
          if (API_CALLERS.has(propName) || propName === 'axios') {
            isApiCall = true;
          }
        }

        if (isApiCall) {
          const endpoint = extractFirstStringArg(node);
          const baseId = `apiCall:${ctx.filePath}:${method.toUpperCase()}:${endpoint ?? 'unknown'}`;
          const apiNodeId = uniqueApiCallId(baseId);
          nodes.push({
            id: apiNodeId,
            type: 'apiCall',
            name: `${method.toUpperCase()} ${endpoint ?? 'unknown'}`,
            filePath: ctx.filePath,
            loc,
            meta: {
              apiEndpoint: endpoint,
              apiMethod: method.toUpperCase(),
            },
          });
          edges.push({ from: fromNodeId, to: apiNodeId, type: 'calls', loc });
          ts.forEachChild(node, visit);
          return;
        }
      }

      // 普通方法调用 obj.method() → 创建 unresolved ref
      if (ts.isIdentifier(obj)) {
        unresolvedRefs.push({
          fromNodeId,
          refName: `${obj.text}.${method}`,
          refType: 'call',
          loc,
        });
      }
    }
    // fetch('/api/xxx') 调用
    else if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      const endpoint = extractFirstStringArg(node);
      if (endpoint) {
        const baseId = `apiCall:${ctx.filePath}:FETCH:${endpoint}`;
        const apiNodeId = uniqueApiCallId(baseId);
        nodes.push({
          id: apiNodeId,
          type: 'apiCall',
          name: `FETCH ${endpoint}`,
          filePath: ctx.filePath,
          loc,
          meta: {
            apiEndpoint: endpoint,
            apiMethod: 'FETCH',
          },
        });
        edges.push({ from: fromNodeId, to: apiNodeId, type: 'calls', loc });
        ts.forEachChild(node, visit);
        return;
      }
    }
    // 普通函数调用 foo()
    else if (ts.isIdentifier(node.expression)) {
      const calledName = node.expression.text;
      // 已在当前文件定义的函数 → 直接创建 calls 边
      const targetId = functionNodes.get(calledName);
      if (targetId) {
        edges.push({ from: fromNodeId, to: targetId, type: 'calls', loc });
      } else {
        unresolvedRefs.push({
          fromNodeId,
          refName: calledName,
          refType: 'call',
          loc,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges, unresolvedRefs };
}
