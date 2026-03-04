import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractFunctions } from '../src/extractors/extractFunctions.js';
import { extractAssignments } from '../src/extractors/extractAssignments.js';
import type { ExtractorContext } from '../src/extractors/types.js';
import type { RepoConfig } from '@aiops/shared-types';

function createContext(
  code: string,
  filePath = 'src/views/test.ts',
  isSetupScript = false
): { sourceFile: ts.SourceFile; ctx: ExtractorContext } {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const config: RepoConfig = {
    repoName: 'test',
    repoPath: '/test',
    scanPaths: ['src'],
    excludePaths: [],
    aliases: { '@': 'src' },
    autoImportDirs: [],
    framework: 'vue3',
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
  return {
    sourceFile,
    ctx: { filePath, config, scriptContent: code, isSetupScript },
  };
}

describe('extractAssignments', () => {
  it('应提取 const 声明', () => {
    const code = `const name = 'hello';`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('variable');
    expect(result.nodes[0].name).toBe('name');
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].type).toBe('defines');
  });

  it('应识别 ref() 并设置 reactiveType', () => {
    const code = `const count = ref(0);`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.reactiveType).toBe('ref');
  });

  it('应识别 reactive() 并设置 reactiveType', () => {
    const code = `const state = reactive({ count: 0 });`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.reactiveType).toBe('reactive');
  });

  it('应跳过箭头函数赋值（避免与 extractFunctions 重复）', () => {
    const code = `const onClick = () => {};`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(0);
  });

  it('setup script 中的顶层变量应标记 isExported', () => {
    const code = `const visible = ref(false);`;
    const { sourceFile, ctx } = createContext(code, 'src/views/test.vue', true);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractAssignments(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.isExported).toBe(true);
    expect(result.nodes[0].meta?.reactiveType).toBe('ref');
  });
});
