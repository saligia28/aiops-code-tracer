import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { extractImports } from '../src/extractors/extractImports.js';
import type { ExtractorContext } from '../src/extractors/types.js';
import type { RepoConfig } from '@aiops/shared-types';

function createContext(code: string, filePath = 'src/views/test.ts'): { sourceFile: ts.SourceFile; ctx: ExtractorContext } {
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

describe('extractImports', () => {
  it('应提取具名导入', () => {
    const code = `import { ref, computed } from 'vue';`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(2);
    expect(result.nodes[0].name).toBe('ref');
    expect(result.nodes[1].name).toBe('computed');
    expect(result.edges.length).toBe(2);
    expect(result.edges[0].type).toBe('imports');
    expect(result.importMap.get('ref')).toEqual({ sourcePath: 'vue', originalName: 'ref' });
  });

  it('应提取默认导入', () => {
    const code = `import axios from 'axios';`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('axios');
    expect(result.importMap.get('axios')).toEqual({ sourcePath: 'axios', originalName: 'default' });
  });

  it('应提取命名空间导入', () => {
    const code = `import * as utils from './utils';`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('utils');
    expect(result.importMap.get('utils')?.originalName).toBe('*');
  });

  it('应提取动态导入', () => {
    const code = `const mod = import('./lazy');`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('dynamic(./lazy)');
  });

  it('应提取 require 调用', () => {
    const code = `const fs = require('fs');`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe('import');
    expect(result.nodes[0].name).toBe('fs');
  });

  it('应解析路径别名', () => {
    const code = `import { useAuth } from '@/hooks/useAuth';`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.importMap.get('useAuth')?.sourcePath).toBe('src/hooks/useAuth');
  });

  it('应处理重命名导入', () => {
    const code = `import { ref as myRef } from 'vue';`;
    const { sourceFile, ctx } = createContext(code);
    const result = extractImports(sourceFile, ctx);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].name).toBe('myRef');
    expect(result.importMap.get('myRef')).toEqual({ sourcePath: 'vue', originalName: 'ref' });
  });
});
