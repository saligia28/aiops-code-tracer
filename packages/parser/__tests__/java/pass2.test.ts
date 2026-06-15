import { describe, it, expect } from 'vitest';
import { runPass1 } from '../../src/languages/java/pass1.js';
import { runPass2 } from '../../src/languages/java/pass2.js';
import { ctx } from './helpers.js';

describe('java pass2 — typeRegistry + extends/implements/injects', () => {
  it('resolves implements and injects-to-implementation across files (same package)', async () => {
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

    // Phase 2：唯一实现 → injects 指向实现类（high），declaredType 仍记录接口 FQN
    const injectEdge = result.resolvedEdges.find((e) => e.type === 'injects');
    expect(injectEdge).toMatchObject({
      from: 'variable:com/foo/UserController.java:com.foo.UserController#userService',
      to: 'class:com/foo/UserServiceImpl.java:com.foo.UserServiceImpl',
    });
    expect(injectEdge?.meta?.declaredType).toBe('com.foo.UserService');
    expect(injectEdge?.meta?.confidence).toBe('high');
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

describe('java pass2 — injects upgraded to implementation resolution', () => {
  it('resolves injects to the unique implementation (high), declaredType stays interface', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const impl = await runPass1(
      'com/foo/SvcImpl.java',
      'package com.foo;\n@Service\nclass SvcImpl implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired private Svc svc; }',
      ctx()
    );
    const own = [i, impl, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('class:com/foo/SvcImpl.java:com.foo.SvcImpl');
    expect(inj?.meta?.confidence).toBe('high');
    expect(inj?.meta?.declaredType).toBe('com.foo.Svc');
  });

  it('points to interface node with low confidence when multiple implementations are ambiguous', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const a = await runPass1(
      'com/foo/SvcA.java',
      'package com.foo;\n@Service\nclass SvcA implements Svc {}',
      ctx()
    );
    const b = await runPass1(
      'com/foo/SvcB.java',
      'package com.foo;\n@Service\nclass SvcB implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired private Svc svc; }',
      ctx()
    );
    const own = [i, a, b, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('interface:com/foo/Svc.java:com.foo.Svc');
    expect(inj?.meta?.confidence).toBe('low');
    expect(inj?.meta?.reason).toBe('multipleImplementations');
  });

  it('uses @Qualifier to pick an implementation among many (medium)', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const a = await runPass1(
      'com/foo/SvcA.java',
      'package com.foo;\n@Service\nclass SvcA implements Svc {}',
      ctx()
    );
    const b = await runPass1(
      'com/foo/SvcB.java',
      'package com.foo;\n@Service\nclass SvcB implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired @Qualifier("svcB") private Svc svc; }',
      ctx()
    );
    const own = [i, a, b, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('class:com/foo/SvcB.java:com.foo.SvcB');
    expect(inj?.meta?.confidence).toBe('medium');
    expect(inj?.meta?.beanQualifier).toBe('svcB');
  });

  it('points to a concrete-class injection target with high confidence', async () => {
    const dep = await runPass1('com/foo/Dep.java', 'package com.foo;\n@Component\nclass Dep {}', ctx());
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired private Dep dep; }',
      ctx()
    );
    const own = [dep, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('class:com/foo/Dep.java:com.foo.Dep');
    expect(inj?.meta?.confidence).toBe('high');
  });

  it('falls back to the interface node (medium) when an interface has no known implementation', async () => {
    const mapper = await runPass1(
      'com/foo/Mapper.java',
      'package com.foo;\n@Mapper\npublic interface Mapper {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Svc.java',
      'package com.foo;\nclass Svc { @Autowired private Mapper mapper; }',
      ctx()
    );
    const own = [mapper, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('interface:com/foo/Mapper.java:com.foo.Mapper');
    expect(inj?.meta?.confidence).toBe('medium');
  });
});

describe('java pass2 — qualifier/bean-name/abstract hardening', () => {
  it('@Qualifier matches an explicit @Service("name") bean name, not just the class name', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const a = await runPass1(
      'com/foo/AlphaService.java',
      'package com.foo;\n@Service("primary")\nclass AlphaService implements Svc {}',
      ctx()
    );
    const b = await runPass1(
      'com/foo/BetaService.java',
      'package com.foo;\n@Service("secondary")\nclass BetaService implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired @Qualifier("primary") private Svc svc; }',
      ctx()
    );
    const own = [i, a, b, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('class:com/foo/AlphaService.java:com.foo.AlphaService');
    expect(inj?.meta?.confidence).toBe('medium');
    expect(inj?.meta?.beanQualifier).toBe('primary');
  });

  it('@Resource(name="...") disambiguates by (default) bean name', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const a = await runPass1(
      'com/foo/SvcA.java',
      'package com.foo;\n@Service\nclass SvcA implements Svc {}',
      ctx()
    );
    const b = await runPass1(
      'com/foo/SvcB.java',
      'package com.foo;\n@Service\nclass SvcB implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Resource(name = "svcB") private Svc svc; }',
      ctx()
    );
    const own = [i, a, b, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    expect(inj?.to).toBe('class:com/foo/SvcB.java:com.foo.SvcB');
    expect(inj?.meta?.confidence).toBe('medium');
    expect(inj?.meta?.beanQualifier).toBe('svcB');
  });

  it('emits deduped class→bean aggregate injection edges alongside field-level ones', async () => {
    const a = await runPass1('com/foo/A.java', 'package com.foo;\n@Service\nclass A {}', ctx());
    const b = await runPass1('com/foo/B.java', 'package com.foo;\n@Service\nclass B {}', ctx());
    const ctrl = await runPass1(
      'com/foo/Ctrl.java',
      [
        'package com.foo;',
        'class Ctrl {',
        '  @Autowired private A a;',
        '  @Autowired private B b;',
        '  @Autowired private A a2;', // 同类型第二字段 → 汇总应去重
        '}',
      ].join('\n'),
      ctx()
    );
    const own = [a, b, ctrl];
    const r = runPass2(own, own, ctx());

    const aggregate = r.resolvedEdges.filter(
      (e) =>
        e.type === 'injects' &&
        e.from === 'class:com/foo/Ctrl.java:com.foo.Ctrl' &&
        e.meta?.reason === 'aggregateInjection'
    );
    expect(aggregate.map((e) => e.to).sort()).toEqual([
      'class:com/foo/A.java:com.foo.A',
      'class:com/foo/B.java:com.foo.B',
    ]);
    // 字段级 injects 仍在（from 为 variable 节点）
    expect(r.resolvedEdges.some((e) => e.type === 'injects' && e.from.startsWith('variable:'))).toBe(
      true
    );
  });

  it('does not select an abstract class as the unique implementation (no high edge to a non-instantiable bean)', async () => {
    const i = await runPass1('com/foo/Svc.java', 'package com.foo;\npublic interface Svc {}', ctx());
    const abs = await runPass1(
      'com/foo/AbstractSvc.java',
      'package com.foo;\npublic abstract class AbstractSvc implements Svc {}',
      ctx()
    );
    const c = await runPass1(
      'com/foo/Ctrl.java',
      'package com.foo;\nclass Ctrl { @Autowired private Svc svc; }',
      ctx()
    );
    const own = [i, abs, c];
    const r = runPass2(own, own, ctx());

    const inj = r.resolvedEdges.find((e) => e.type === 'injects');
    // 唯一“实现”是抽象类（不可实例化）→ 不报 high 指向它，退回接口节点 medium
    expect(inj?.to).toBe('interface:com/foo/Svc.java:com.foo.Svc');
    expect(inj?.meta?.confidence).toBe('medium');
  });
});
