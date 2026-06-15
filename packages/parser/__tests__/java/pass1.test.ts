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

describe('java pass1 — class / interface / enum', () => {
  it('extracts class with annotations, stereotype, extends/implements pendingRefs', async () => {
    const src = [
      'package com.foo;',
      '@Service',
      'public class UserServiceImpl extends Base implements UserService {',
      '}',
    ].join('\n');

    const result = await runPass1('UserServiceImpl.java', src, ctx());
    const data = result.parserData as JavaParserData;

    const cls = result.nodes.find((n) => n.type === 'class' && n.name === 'UserServiceImpl');
    expect(cls?.id).toBe('class:UserServiceImpl.java:com.foo.UserServiceImpl');
    expect(cls?.meta?.springStereotype).toBe('service');
    expect(cls?.meta?.annotations).toEqual(['@Service']);
    expect(cls?.meta?.package).toBe('com.foo');

    const extendsRef = data.pendingRefs.find((r) => r.kind === 'extends');
    expect(extendsRef).toMatchObject({
      kind: 'extends',
      fromTypeFQN: 'com.foo.UserServiceImpl',
      targetTypeName: 'Base',
    });
    const implRef = data.pendingRefs.find((r) => r.kind === 'implements');
    expect(implRef).toMatchObject({
      kind: 'implements',
      fromTypeFQN: 'com.foo.UserServiceImpl',
      targetTypeName: 'UserService',
    });
  });

  it('maps interface to interface node and enum to class node with kind=enum', async () => {
    const src = [
      'package com.foo;',
      'public interface UserService {}',
      'enum Color { RED, GREEN }',
    ].join('\n');

    const result = await runPass1('Types.java', src, ctx());

    const iface = result.nodes.find((n) => n.name === 'UserService');
    expect(iface?.type).toBe('interface');
    expect(iface?.id).toBe('interface:Types.java:com.foo.UserService');

    const en = result.nodes.find((n) => n.name === 'Color');
    expect(en?.type).toBe('class');
    expect(en?.meta?.kind).toBe('enum');
    expect(en?.id).toBe('class:Types.java:com.foo.Color');
  });

  it('builds nested-class FQN as Outer.Inner', async () => {
    const src = ['package com.foo;', 'class Outer {', '  static class Inner {}', '}'].join('\n');
    const result = await runPass1('Outer.java', src, ctx());
    const inner = result.nodes.find((n) => n.name === 'Inner');
    expect(inner?.id).toBe('class:Outer.java:com.foo.Outer.Inner');
  });
});
