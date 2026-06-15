import { describe, it, expect } from 'vitest';
import { runPass1 } from '../../src/languages/java/pass1.js';
import { runPass2 } from '../../src/languages/java/pass2.js';
import { ctx } from './helpers.js';

describe('java pass2 — typeRegistry + extends/implements/injects', () => {
  it('resolves implements and declaration-level injects across files (same package)', async () => {
    const iface = await runPass1(
      'com/foo/UserService.java',
      'package com.foo;\npublic interface UserService {}',
      ctx()
    );
    const impl = await runPass1(
      'com/foo/UserServiceImpl.java',
      'package com.foo;\n@Service\npublic class UserServiceImpl implements UserService {}',
      ctx()
    );
    const controller = await runPass1(
      'com/foo/UserController.java',
      [
        'package com.foo;',
        '@RestController',
        'public class UserController {',
        '  @Autowired private UserService userService;',
        '}',
      ].join('\n'),
      ctx()
    );

    const own = [iface, impl, controller];
    const result = runPass2(own, own, ctx());

    const implEdge = result.resolvedEdges.find((e) => e.type === 'implements');
    expect(implEdge).toMatchObject({
      from: 'class:com/foo/UserServiceImpl.java:com.foo.UserServiceImpl',
      to: 'interface:com/foo/UserService.java:com.foo.UserService',
    });
    expect(implEdge?.meta?.confidence).toBe('high');

    const injectEdge = result.resolvedEdges.find((e) => e.type === 'injects');
    expect(injectEdge).toMatchObject({
      from: 'variable:com/foo/UserController.java:com.foo.UserController#userService',
      to: 'interface:com/foo/UserService.java:com.foo.UserService',
    });
    expect(injectEdge?.meta?.declaredType).toBe('com.foo.UserService');
    expect(injectEdge?.meta?.confidence).toBe('medium');
  });

  it('resolves extends via import table (cross package)', async () => {
    const base = await runPass1(
      'com/base/Base.java',
      'package com.base;\npublic class Base {}',
      ctx()
    );
    const sub = await runPass1(
      'com/foo/Sub.java',
      'package com.foo;\nimport com.base.Base;\npublic class Sub extends Base {}',
      ctx()
    );
    const own = [base, sub];
    const result = runPass2(own, own, ctx());

    const ext = result.resolvedEdges.find((e) => e.type === 'extends');
    expect(ext).toMatchObject({
      from: 'class:com/foo/Sub.java:com.foo.Sub',
      to: 'class:com/base/Base.java:com.base.Base',
    });
  });

  it('counts unresolved and emits no edge when target type is unknown', async () => {
    const a = await runPass1('A.java', 'package com.foo;\nclass A extends Unknown {}', ctx());
    const own = [a];
    const result = runPass2(own, own, ctx());

    expect(result.resolvedEdges.filter((e) => e.type === 'extends')).toHaveLength(0);
    expect(result.unresolvedCount).toBeGreaterThan(0);
    expect(result.totalRefs).toBeGreaterThan(0);
  });

  it('resolves type via wildcard import', async () => {
    const base = await runPass1(
      'com/base/Base.java',
      'package com.base;\npublic class Base {}',
      ctx()
    );
    const sub = await runPass1(
      'com/foo/Sub.java',
      'package com.foo;\nimport com.base.*;\npublic class Sub extends Base {}',
      ctx()
    );
    const own = [base, sub];
    const result = runPass2(own, own, ctx());

    const ext = result.resolvedEdges.find((e) => e.type === 'extends');
    expect(ext?.to).toBe('class:com/base/Base.java:com.base.Base');
  });

  it('carries @Qualifier into injects edge beanQualifier', async () => {
    const iface = await runPass1(
      'com/foo/Repo.java',
      'package com.foo;\npublic interface Repo {}',
      ctx()
    );
    const user = await runPass1(
      'com/foo/Svc.java',
      [
        'package com.foo;',
        'class Svc {',
        '  @Autowired @Qualifier("primary") private Repo repo;',
        '}',
      ].join('\n'),
      ctx()
    );
    const own = [iface, user];
    const result = runPass2(own, own, ctx());

    const injectEdge = result.resolvedEdges.find((e) => e.type === 'injects');
    expect(injectEdge?.meta?.beanQualifier).toBe('primary');
  });
});
