import fg from 'fast-glob';
import type { RepoConfig } from '@aiops/shared-types';

/**
 * 按仓库配置收集需要扫描的文件列表
 */
export async function collectFiles(config: RepoConfig): Promise<string[]> {
  const patterns = config.scanPaths.map((p) =>
    `${p}/**/*.{vue,ts,js,tsx,jsx}`
  );

  const files = await fg(patterns, {
    cwd: config.repoPath,
    ignore: config.excludePaths,
    absolute: false,
    onlyFiles: true,
  });

  return files.sort();
}
