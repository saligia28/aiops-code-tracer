import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractFunctions } from '../src/extractors/extractFunctions.js';
import type { ExtractorContext } from '../src/extractors/types.js';
import type { RepoConfig } from '@aiops/shared-types';

function createContext(
  code: string,
  filePath = 'src/views/test.ts',
  isSetupScript = false,
  scriptKind = ts.ScriptKind.TS
): { sourceFile: ts.SourceFile; ctx: ExtractorContext } {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.ESNext, true, scriptKind);
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

describe('extractFunctions', () => {
  it('应提取函数声明', () => {
    const code = `function handleSubmit() { return 1; }`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('function');
    expect(result.nodes[0].name).toBe('handleSubmit');
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].type).toBe('defines');
  });

  it('应识别 async 和 export 修饰符', () => {
    const code = `export async function fetchData() { return 1; }`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.isAsync).toBe(true);
    expect(result.nodes[0].meta?.isExported).toBe(true);
  });

  it('应提取箭头函数', () => {
    const code = `const onClick = () => { console.log('click'); };`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('onClick');
    expect(result.functionNodes.get('onClick')).toBeDefined();
  });

  it('应提取 export default 函数', () => {
    const code = `export default function() { return 1; }`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('default');
    expect(result.nodes[0].meta?.isDefaultExport).toBe(true);
    expect(result.nodes[0].meta?.isExported).toBe(true);
  });

  it('应提取方法声明', () => {
    const code = `const obj = { handleClick() { return 1; } };`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('handleClick');
  });

  it('setup script 中的顶层函数应自动标记 isExported', () => {
    const code = `function handleSubmit() { return 1; }`;
    const { sourceFile, ctx } = createContext(code, 'src/views/test.vue', true);
    const result = extractFunctions(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.isExported).toBe(true);
  });

  it('同名方法应生成不同 ID（#N 后缀去重）', () => {
    const code = `
const obj1 = { handleClick() { return 1; } };
const obj2 = { handleClick() { return 2; } };
`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractFunctions(sourceFile, ctx);

    const clickNodes = result.nodes.filter(n => n.name.startsWith('handleClick'));
    expect(clickNodes.length).toBe(2);
    expect(clickNodes[0].name).toBe('handleClick');
    expect(clickNodes[1].name).toBe('handleClick#2');
    expect(clickNodes[0].id).not.toBe(clickNodes[1].id);
  });
});
