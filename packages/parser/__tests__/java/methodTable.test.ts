import { describe, it, expect } from 'vitest';
import { runPass1 } from '../../src/languages/java/pass1.js';
import { buildInheritanceMaps, buildMethodTable } from '../../src/languages/java/methodTable.js';
import { ctx } from './helpers.js';

describe('java methodTable — inheritance maps', () => {
  it('builds implementsMap interface→impls and extendsMap child→parents', async () => {
    const i = await runPass1('com/foo/I.java', 'package com.foo;\npublic interface I {}', ctx());
    const impl = await runPass1(
      'com/foo/Impl.java',
      'package com.foo;\nclass Impl implements I {}',
      ctx()
    );
    const base = await runPass1('com/foo/Base.java', 'package com.foo;\nclass Base {}', ctx());
    const sub = await runPass1(
      'com/foo/Sub.java',
      'package com.foo;\nclass Sub extends Base {}',
      ctx()
    );

    const maps = buildInheritanceMaps([i, impl, base, sub]);

    expect(maps.implementsMap.get('com.foo.I')).toEqual(['com.foo.Impl']);
    expect(maps.extendsMap.get('com.foo.Sub')).toEqual(['com.foo.Base']);
  });
});

describe('java methodTable — method table with inheritance merge', () => {
  it('merges inherited methods along extends/implements chain', async () => {
    const i = await runPass1(
      'com/foo/Svc.java',
      'package com.foo;\npublic interface Svc { void doIt(); }',
      ctx()
    );
    const impl = await runPass1(
      'com/foo/SvcImpl.java',
      'package com.foo;\nclass SvcImpl implements Svc { public void doIt() {} }',
      ctx()
    );

    const maps = buildInheritanceMaps([i, impl]);
    const mt = buildMethodTable([i, impl], maps);

    // 实现类自身有 doIt
    const implDoIt = mt.get('com.foo.SvcImpl')?.get('doIt');
    expect(implDoIt?.length).toBe(1);
    expect(implDoIt?.[0].nodeId).toContain('SvcImpl');
    // 接口自身也在表里
    expect(mt.get('com.foo.Svc')?.get('doIt')?.length).toBe(1);
  });

  it('keeps overloads as distinct entries and selects by paramTypes', async () => {
    const c = await runPass1(
      'com/foo/Repo.java',
      [
        'package com.foo;',
        'class Repo {',
        '  void find(Long id) {}',
        '  void find(String s) {}',
        '}',
      ].join('\n'),
      ctx()
    );
    const maps = buildInheritanceMaps([c]);
    const mt = buildMethodTable([c], maps);

    const find = mt.get('com.foo.Repo')?.get('find');
    expect(find?.length).toBe(2);
    expect(find?.map((e) => e.paramTypes.join(',')).sort()).toEqual([
      'java.lang.Long',
      'java.lang.String',
    ]);
  });
});
