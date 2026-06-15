import { describe, it, expect } from 'vitest';
import type { RepoConfig } from '@aiops/shared-types';
import { runPass1 } from '../../src/languages/java/pass1.js';
import type { JavaParserData } from '../../src/languages/java/types.js';
import type { ParserContext } from '../../src/languages/types.js';

function ctx(): ParserContext {
  const config: RepoConfig = {
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
  };
  return { config };
}

describe('java pass1 — package + imports', () => {
  it('builds importTable for normal / wildcard / static imports', async () => {
    const src = [
      'package com.foo;',
      'import com.bar.A;',
      'import com.baz.*;',
      'import static com.q.U.f;',
      'class X {}',
    ].join('\n');

    const result = await runPass1('X.java', src, ctx());
    const data = result.parserData as JavaParserData;

    // 普通 import：短名 → FQN
    expect(data.typeEnv.importTable['A']).toBe('com.bar.A');
    // wildcard：原样记录，供 Pass2 FQN 补全
    expect(data.typeEnv.importTable['com.baz.*']).toBe('com.baz.*');
    // static 成员：成员名 → FQN
    expect(data.typeEnv.importTable['f']).toBe('com.q.U.f');

    // 每条 import 产出一个 import 节点
    const importNodes = result.nodes.filter((n) => n.type === 'import');
    expect(importNodes).toHaveLength(3);
  });
});
