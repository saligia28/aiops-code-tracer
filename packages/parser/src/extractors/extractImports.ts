import ts from 'typescript';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { resolveRelativePath } from '../scanner/pathResolver.js';
import type { ExtractorContext, UnresolvedRef } from './types.js';
import { getLoc } from './types.js';

interface ExtractImportsResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
  /** localName → { sourcePath, originalName } 映射，供其他提取器使用 */
  importMap: Map<string, { sourcePath: string; originalName: string }>;
}

/**
 * 提取文件中所有 import 声明
 */
export function extractImports(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext
): ExtractImportsResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: UnresolvedRef[] = [];
  const importMap = new Map<string, { sourcePath: string; originalName: string }>();

  const fileNodeId = `file:${ctx.filePath}:${ctx.filePath.split('/').pop()}`;

  function processImportDeclaration(node: ts.ImportDeclaration) {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;

    const rawSource = moduleSpecifier.text;
    const resolvedSource = resolveRelativePath(rawSource, ctx.filePath, ctx.config);
    const loc = getLoc(sourceFile, node.getStart());

    const importClause = node.importClause;
    if (!importClause) {
      // side-effect import: import './polyfill'
      const importNodeId = `import:${ctx.filePath}:${rawSource}`;
      nodes.push({
        id: importNodeId,
        type: 'import',
        name: rawSource,
        filePath: ctx.filePath,
        loc,
      });
      edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
      return;
    }

    // default import: import Foo from './foo'
    if (importClause.name) {
      const localName = importClause.name.text;
      const importNodeId = `import:${ctx.filePath}:${localName}`;
      nodes.push({
        id: importNodeId,
        type: 'import',
        name: localName,
        filePath: ctx.filePath,
        loc,
      });
      edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
      importMap.set(localName, { sourcePath: resolvedSource, originalName: 'default' });
      unresolvedRefs.push({
        fromNodeId: importNodeId,
        refName: localName,
        originalName: 'default',
        refType: 'import',
        importSource: resolvedSource,
        loc,
      });
    }

    const namedBindings = importClause.namedBindings;
    if (!namedBindings) return;

    if (ts.isNamespaceImport(namedBindings)) {
      // namespace import: import * as ns from './foo'
      const localName = namedBindings.name.text;
      const importNodeId = `import:${ctx.filePath}:${localName}`;
      nodes.push({
        id: importNodeId,
        type: 'import',
        name: localName,
        filePath: ctx.filePath,
        loc,
      });
      edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
      importMap.set(localName, { sourcePath: resolvedSource, originalName: '*' });
      unresolvedRefs.push({
        fromNodeId: importNodeId,
        refName: localName,
        originalName: '*',
        refType: 'import',
        importSource: resolvedSource,
        loc,
      });
    } else if (ts.isNamedImports(namedBindings)) {
      // named imports: import { a, b as c } from './foo'
      for (const element of namedBindings.elements) {
        const localName = element.name.text;
        const originalName = element.propertyName?.text ?? localName;
        const importNodeId = `import:${ctx.filePath}:${localName}`;
        nodes.push({
          id: importNodeId,
          type: 'import',
          name: localName,
          filePath: ctx.filePath,
          loc: getLoc(sourceFile, element.getStart()),
        });
        edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
        importMap.set(localName, { sourcePath: resolvedSource, originalName });
        unresolvedRefs.push({
          fromNodeId: importNodeId,
          refName: localName,
          originalName,
          refType: 'import',
          importSource: resolvedSource,
          loc: getLoc(sourceFile, element.getStart()),
        });
      }
    }
  }

  function processDynamicImport(node: ts.CallExpression) {
    if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return;
    if (node.arguments.length === 0) return;
    const arg = node.arguments[0];
    if (!ts.isStringLiteral(arg)) return;

    const rawSource = arg.text;
    const resolvedSource = resolveRelativePath(rawSource, ctx.filePath, ctx.config);
    const loc = getLoc(sourceFile, node.getStart());
    const importNodeId = `import:${ctx.filePath}:dynamic:${rawSource}`;
    nodes.push({
      id: importNodeId,
      type: 'import',
      name: `dynamic(${rawSource})`,
      filePath: ctx.filePath,
      loc,
    });
    edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
    unresolvedRefs.push({
      fromNodeId: importNodeId,
      refName: rawSource,
      refType: 'import',
      importSource: resolvedSource,
      loc,
    });
  }

  function processRequireCall(node: ts.CallExpression) {
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return;
    if (node.arguments.length === 0) return;
    const arg = node.arguments[0];
    if (!ts.isStringLiteral(arg)) return;

    const rawSource = arg.text;
    const resolvedSource = resolveRelativePath(rawSource, ctx.filePath, ctx.config);
    const loc = getLoc(sourceFile, node.getStart());
    const importNodeId = `import:${ctx.filePath}:${rawSource}`;
    nodes.push({
      id: importNodeId,
      type: 'import',
      name: rawSource,
      filePath: ctx.filePath,
      loc,
    });
    edges.push({ from: fileNodeId, to: importNodeId, type: 'imports', loc });
    unresolvedRefs.push({
      fromNodeId: importNodeId,
      refName: rawSource,
      refType: 'import',
      importSource: resolvedSource,
      loc,
    });
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      processImportDeclaration(node);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        processDynamicImport(node);
      } else {
        processRequireCall(node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { nodes, edges, unresolvedRefs, importMap };
}
