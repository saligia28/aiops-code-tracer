import { describe, it, expect } from 'vitest';
import type { RepoConfig } from '@aiops/shared-types';
import { JavaLanguageParser } from '../../src/languages/java/index.js';
import type { ParserContext } from '../../src/languages/types.js';

function javaConfig(): RepoConfig {
  return {
    repoName: 'test',
    repoPath: '/tmp/repo',
    scanPaths: ['src/main/java'],
    excludePaths: [],
    aliases: {},
    autoImportDirs: [],
    framework: 'java',
    parsers: ['java'],
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
}

describe('JavaLanguageParser skeleton', () => {
  const ctx: ParserContext = { config: javaConfig() };

  it('exposes java id and .java extension', () => {
    expect(JavaLanguageParser.id).toBe('java');
    expect(JavaLanguageParser.extensions).toContain('.java');
  });

  it('parses a trivial class into file + class nodes', async () => {
    const result = await JavaLanguageParser.parseFile(
      'X.java',
      'package a; class X {}',
      ctx
    );
    expect(result.parserId).toBe('java');

    const fileNode = result.nodes.find((n) => n.type === 'file');
    expect(fileNode?.name).toBe('X.java');
    expect(fileNode?.id).toBe('file:X.java:X.java');

    const classNode = result.nodes.find((n) => n.type === 'class');
    expect(classNode?.name).toBe('X');
    expect(classNode?.id).toBe('class:X.java:a.X');
    expect(classNode?.meta?.package).toBe('a');
  });
});
