import { describe, it, expect } from 'vitest';
import { runPass1 } from '../../src/languages/java/pass1.js';
import { buildInheritanceMaps } from '../../src/languages/java/methodTable.js';
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
