import path from 'path';
import type { RepoConfig } from '@aiops/shared-types';

/**
 * 解析路径别名，将 @/xxx 转为实际相对路径
 */
export function resolveAliasPath(
  importPath: string,
  config: RepoConfig
): string {
  for (const [alias, target] of Object.entries(config.aliases)) {
    if (importPath.startsWith(alias + '/')) {
      return importPath.replace(alias, target);
    }
    if (importPath === alias) {
      return target;
    }
  }
  return importPath;
}

/**
 * 解析相对路径，返回相对于仓库根目录的路径
 */
export function resolveRelativePath(
  importPath: string,
  fromFile: string,
  config: RepoConfig
): string {
  const resolved = resolveAliasPath(importPath, config);

  if (resolved.startsWith('.')) {
    const dir = path.dirname(fromFile);
    return path.normalize(path.join(dir, resolved));
  }

  return resolved;
}
