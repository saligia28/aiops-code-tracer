import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { parseFile, resolvePhase } from '../src/graphBuilder.js';
import type { RepoConfig } from '@aiops/shared-types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createTempRepo(files: Record<string, string>): { repoPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiops-test-'));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return {
    repoPath: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function createConfig(repoPath: string): RepoConfig {
  return {
    repoName: 'test',
    repoPath,
    scanPaths: ['src'],
    excludePaths: [],
    aliases: { '@': 'src' },
    autoImportDirs: [],
    framework: 'vue3',
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
}

describe('graphBuilder', () => {
  it('应解析单个 TS 文件产出节点和边', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/utils/helper.ts': `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export const MAX_RETRY = 3;

const internal = () => {};
`,
    });

    try {
      const config = createConfig(repoPath);
      const result = parseFile('src/utils/helper.ts', config);

      // 1 file + 2 functions (formatDate, internal) + 1 variable (MAX_RETRY)
      expect(result.nodes.length).toBe(4);
      expect(result.nodes.filter(n => n.type === 'file').length).toBe(1);
      expect(result.nodes.filter(n => n.type === 'function').length).toBe(2);
      expect(result.nodes.filter(n => n.type === 'variable').length).toBe(1);

      // formatDate 应标记 isExported
      const formatDate = result.nodes.find(n => n.name === 'formatDate');
      expect(formatDate?.meta?.isExported).toBe(true);

      // MAX_RETRY 应标记 isExported
      const maxRetry = result.nodes.find(n => n.name === 'MAX_RETRY');
      expect(maxRetry?.meta?.isExported).toBe(true);

      // 3 defines 边
      expect(result.edges.filter(e => e.type === 'defines').length).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('应跨文件解析导入引用', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/utils/helper.ts': `
export function formatDate(date: Date): string {
  return date.toISOString();
}
`,
      'src/views/page.ts': `
import { formatDate } from '../utils/helper';

function render() {
  formatDate(new Date());
}
`,
    });

    try {
      const config = createConfig(repoPath);
      const result1 = parseFile('src/utils/helper.ts', config);
      const result2 = parseFile('src/views/page.ts', config);

      const resolveResult = resolvePhase([result1, result2], config);

      // formatDate 调用应被解析
      expect(resolveResult.resolvedEdges.length).toBeGreaterThan(0);
      const callEdge = resolveResult.resolvedEdges.find(e => e.type === 'calls');
      expect(callEdge).toBeDefined();
      expect(callEdge?.to).toContain('formatDate');
    } finally {
      cleanup();
    }
  });

  it('应处理无 script 的 Vue 文件（仅返回 file 节点）', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/views/empty.vue': `
<template>
  <div>Hello</div>
</template>

<style scoped>
div { color: red; }
</style>
`,
    });

    try {
      const config = createConfig(repoPath);
      const result = parseFile('src/views/empty.vue', config);

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe('file');
      expect(result.edges.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('文件不存在时 result.error 应有值', () => {
    const { repoPath, cleanup } = createTempRepo({});

    try {
      const config = createConfig(repoPath);
      const result = parseFile('src/nonexistent.ts', config);

      expect(result.error).toBe('FILE_READ_ERROR');
      // 仍然应有 file 节点
      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].type).toBe('file');
    } finally {
      cleanup();
    }
  });

  it('无 script 的 Vue 文件不应标记 error', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/views/nojs.vue': `
<template><div>OK</div></template>
`,
    });

    try {
      const config = createConfig(repoPath);
      const result = parseFile('src/views/nojs.vue', config);

      expect(result.error).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('点号引用应能解析到本地定义', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/views/page.ts': `
const form = { name: '' };

function handleSubmit() {
  form.validate();
}
`,
    });

    try {
      const config = createConfig(repoPath);
      const result = parseFile('src/views/page.ts', config);

      const resolveResult = resolvePhase([result], config);

      // form.validate 应通过 baseName 'form' 匹配到本地 variable 节点
      const usesEdge = resolveResult.resolvedEdges.find(e => e.type === 'uses');
      expect(usesEdge).toBeDefined();
      expect(usesEdge?.to).toContain('form');
    } finally {
      cleanup();
    }
  });

  it('$refs 组件方法调用应解析到被引用组件方法', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/components/InventoryCheckDialog.ts': `
export function openDialog(payload: any) {
  return payload;
}
export default {};
`,
      'src/views/page.ts': `
import InventoryCheckDialog from '../components/InventoryCheckDialog';

function inventoryCheck() {
  this.$refs.InventoryCheckDialog.openDialog({ id: 1 });
}
`,
    });

    try {
      const config = createConfig(repoPath);
      const componentResult = parseFile('src/components/InventoryCheckDialog.ts', config);
      const pageResult = parseFile('src/views/page.ts', config);

      const resolveResult = resolvePhase([componentResult, pageResult], config);

      const callEdge = resolveResult.resolvedEdges.find((edge) =>
        edge.type === 'calls' && edge.to.includes('openDialog')
      );
      expect(callEdge).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('函数别名调用应解析到导入函数目标', () => {
    const { repoPath, cleanup } = createTempRepo({
      'src/api/index.ts': `
export function verify() { return true; }
export function batchVerify() { return true; }
`,
      'src/views/dialog.ts': `
import { verify, batchVerify } from '../api/index';
function confirmData(payload: any) {
  const requestMethod = this.isBatch ? batchVerify : verify;
  requestMethod(payload);
}
`,
    });

    try {
      const config = createConfig(repoPath);
      const apiResult = parseFile('src/api/index.ts', config);
      const dialogResult = parseFile('src/views/dialog.ts', config);
      const resolveResult = resolvePhase([apiResult, dialogResult], config);

      const toVerify = resolveResult.resolvedEdges.find((edge) => edge.type === 'calls' && edge.to.includes(':verify'));
      const toBatchVerify = resolveResult.resolvedEdges.find((edge) => edge.type === 'calls' && edge.to.includes(':batchVerify'));
      expect(toVerify).toBeDefined();
      expect(toBatchVerify).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
