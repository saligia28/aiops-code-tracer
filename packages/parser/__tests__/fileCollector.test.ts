import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { collectFiles } from '../src/scanner/fileCollector.js';
import type { RepoConfig } from '@aiops/shared-types';

function createTempRepo(files: Record<string, string>): { repoPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiops-collector-'));
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
    scanPaths: ['apps', 'packages'],
    excludePaths: ['node_modules', 'dist', '*.spec.*', '*.test.*'],
    aliases: { '@': 'src' },
    autoImportDirs: [],
    framework: 'vue3',
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
}

describe('collectFiles', () => {
  it('应过滤 node_modules / dist / test 文件', async () => {
    const { repoPath, cleanup } = createTempRepo({
      'apps/web/src/main.ts': 'console.log(1)',
      'apps/web/node_modules/foo/index.ts': 'export const x = 1',
      'apps/web/dist/app.js': 'console.log(2)',
      'packages/parser/src/index.ts': 'export const y = 2',
      'packages/parser/src/index.test.ts': 'describe("x", () => {})',
    });

    try {
      const config = createConfig(repoPath);
      const files = await collectFiles(config);

      expect(files).toContain('apps/web/src/main.ts');
      expect(files).toContain('packages/parser/src/index.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      expect(files.some((f) => f.includes('/dist/'))).toBe(false);
      expect(files.some((f) => f.includes('.test.'))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
