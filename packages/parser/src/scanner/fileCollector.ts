import fg from 'fast-glob';
import type { RepoConfig } from '@aiops/shared-types';
import { scanExtensionsFor } from '../languages/registry.js';

function normalize(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function shouldIgnore(filePath: string, excludePatterns: string[]): boolean {
  const normalized = normalize(filePath);

  // Hard guards: prevent dependency/artifact directories from entering graph.
  const blockedSegments = ['node_modules', 'dist', '.git', 'coverage', '.turbo', '.next', '.nuxt'];
  for (const seg of blockedSegments) {
    if (normalized.includes(`/${seg}/`) || normalized.startsWith(`${seg}/`)) {
      return true;
    }
  }

  if (normalized.includes('.spec.') || normalized.includes('.test.')) {
    return true;
  }

  for (const pattern of excludePatterns) {
    const p = normalize(pattern.trim());
    if (!p) continue;

    if (p.includes('*.spec.') && normalized.includes('.spec.')) return true;
    if (p.includes('*.test.') && normalized.includes('.test.')) return true;
    if (p.startsWith('*.') && normalized.endsWith(p.slice(1))) return true;
    if (!p.includes('*') && (normalized.includes(`/${p}/`) || normalized.startsWith(`${p}/`))) {
      return true;
    }
  }

  return false;
}

/**
 * 按仓库配置收集需要扫描的文件列表
 */
export async function collectFiles(config: RepoConfig): Promise<string[]> {
  const exts = scanExtensionsFor(config.parsers); // e.g. ['.java'] or ['.vue','.ts','.js','.tsx','.jsx']
  const extGroup = exts.map((e) => e.slice(1)).join(','); // 'java' or 'vue,ts,js,tsx,jsx'
  // fast-glob 不会展开单成员花括号 `{java}`（无逗号时按字面量处理，匹配不到任何文件），
  // 因此单扩展名时用无花括号形式。
  const extPattern = exts.length === 1 ? `*.${extGroup}` : `*.{${extGroup}}`;
  const patterns = config.scanPaths.map((p) => `${p}/**/${extPattern}`);

  const defaultIgnores = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/.nuxt/**',
  ];
  const userIgnores = config.excludePaths.map((pattern) => {
    if (pattern.includes('/**') || pattern.startsWith('**/')) return pattern;
    if (pattern.includes('*')) return `**/${pattern}`;
    return `**/${pattern}/**`;
  });

  const files = await fg(patterns, {
    cwd: config.repoPath,
    ignore: [...defaultIgnores, ...userIgnores],
    absolute: false,
    onlyFiles: true,
  });

  const filtered = files.filter((file) => !shouldIgnore(file, config.excludePaths));
  return filtered.sort();
}
