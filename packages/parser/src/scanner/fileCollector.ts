import fg from 'fast-glob';
import type { RepoConfig } from '@aiops/shared-types';

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
  const patterns = config.scanPaths.map((p) =>
    `${p}/**/*.{vue,ts,js,tsx,jsx}`
  );

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
