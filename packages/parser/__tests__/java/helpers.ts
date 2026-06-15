import type { RepoConfig } from '@aiops/shared-types';
import type { ParserContext } from '../../src/languages/types.js';

/** 测试用最小 Java RepoConfig / ParserContext 工厂（Java 解析测试共用） */
export function javaRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    repoName: 't',
    repoPath: '/tmp',
    scanPaths: ['src/main/java'],
    excludePaths: [],
    aliases: {},
    autoImportDirs: [],
    framework: 'java',
    parsers: ['java'],
    stateManagement: 'none',
    scriptStyle: 'composition',
    ...overrides,
  };
}

export function ctx(overrides: Partial<RepoConfig> = {}): ParserContext {
  return { config: javaRepoConfig(overrides) };
}
