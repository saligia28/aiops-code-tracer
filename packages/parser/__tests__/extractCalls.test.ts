import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractFunctions } from '../src/extractors/extractFunctions.js';
import { extractCalls } from '../src/extractors/extractCalls.js';
import type { ExtractorContext } from '../src/extractors/types.js';
import type { RepoConfig } from '@aiops/shared-types';

function createContext(code: string, filePath = 'src/views/test.ts'): {
  sourceFile: ts.SourceFile;
  ctx: ExtractorContext;
} {
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
    ctx: { filePath, config, scriptContent: code, isSetupScript: false },
  };
}

describe('extractCalls', () => {
  it('应提取普通函数调用并创建 unresolved ref', () => {
    const code = `
function handleSubmit() {
  validate();
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.unresolvedRefs.length).toBe(1);
    expect(result.unresolvedRefs[0].refName).toBe('validate');
    expect(result.unresolvedRefs[0].refType).toBe('call');
  });

  it('应提取方法调用', () => {
    const code = `
function init() {
  router.push('/home');
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.unresolvedRefs.length).toBe(1);
    expect(result.unresolvedRefs[0].refName).toBe('router.push');
  });

  it('应识别 axios.post 调用并创建 apiCall 节点', () => {
    const code = `
function submitForm() {
  axios.post('/api/submit', { name: 'test' });
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('apiCall');
    expect(result.nodes[0].meta?.apiEndpoint).toBe('/api/submit');
    expect(result.nodes[0].meta?.apiMethod).toBe('POST');
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].type).toBe('calls');
  });

  it('应识别 axios.get 调用', () => {
    const code = `
function fetchList() {
  axios.get('/api/list');
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].meta?.apiMethod).toBe('GET');
  });

  it('应处理同文件内的函数调用创建 calls 边', () => {
    const code = `
function validate() { return true; }
function handleSubmit() {
  validate();
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    // validate() 在同文件中有定义，应直接创建 calls 边
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].type).toBe('calls');
    expect(result.unresolvedRefs.length).toBe(0);
  });

  it('应识别 fetch 调用', () => {
    const code = `
function loadData() {
  fetch('/api/data');
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('apiCall');
    expect(result.nodes[0].meta?.apiEndpoint).toBe('/api/data');
    expect(result.nodes[0].meta?.apiMethod).toBe('FETCH');
  });

  it('同文件同 API 调用应生成不同 ID', () => {
    const code = `
function refreshA() {
  axios.get('/api/list');
}
function refreshB() {
  axios.get('/api/list');
}`;
    const { sourceFile, ctx } = createContext(code);
    const funcResult = extractFunctions(sourceFile, ctx);
    const result = extractCalls(sourceFile, ctx, funcResult.functionNodes);

    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].id).not.toBe(result.nodes[1].id);
    // 第二个应带 #2 后缀
    expect(result.nodes[1].id).toContain('#2');
  });
});
