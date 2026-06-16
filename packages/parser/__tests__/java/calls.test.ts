import { describe, it, expect } from 'vitest';
import { inferReceiverType } from '../../src/languages/java/callResolver.js';
import type { ReceiverScope } from '../../src/languages/java/callResolver.js';
import { buildTypeRegistry } from '../../src/languages/java/typeResolver.js';
import { runPass1 } from '../../src/languages/java/pass1.js';
import { runPass2 } from '../../src/languages/java/pass2.js';
import { ctx } from './helpers.js';

function scope(overrides: Partial<ReceiverScope> = {}): ReceiverScope {
  return {
    ownerFQN: 'com.foo.Ctrl',
    fieldDeclaredTypes: {},
    fieldResolvedBeans: {},
    localVarTypes: {},
    importTable: {},
    filePackage: 'com.foo',
    registry: buildTypeRegistry([]),
    ...overrides,
  };
}

describe('java callResolver — inferReceiverType', () => {
  it('empty / this receiver → owner class FQN', () => {
    expect(inferReceiverType('', scope())).toBe('com.foo.Ctrl');
    expect(inferReceiverType('this', scope())).toBe('com.foo.Ctrl');
  });

  it('prefers the injected implementation type for a field receiver', () => {
    expect(
      inferReceiverType(
        'svc',
        scope({
          fieldDeclaredTypes: { svc: 'com.foo.Svc' },
          fieldResolvedBeans: { svc: 'com.foo.SvcImpl' },
        })
      )
    ).toBe('com.foo.SvcImpl');
  });

  it('falls back to the declared field type when no resolved bean', () => {
    expect(inferReceiverType('repo', scope({ fieldDeclaredTypes: { repo: 'com.foo.Repo' } }))).toBe(
      'com.foo.Repo'
    );
  });

  it('local variable / parameter shadows a field of the same name', () => {
    expect(
      inferReceiverType(
        'x',
        scope({
          localVarTypes: { x: 'Bar' },
          fieldDeclaredTypes: { x: 'Foo' },
          importTable: { Bar: 'com.foo.Bar', Foo: 'com.foo.Foo' },
        })
      )
    ).toBe('com.foo.Bar');
  });

  it('chained / unknown receivers degrade to undefined', () => {
    expect(inferReceiverType('a.b()', scope())).toBeUndefined();
    expect(inferReceiverType('unknownName', scope())).toBeUndefined();
  });
});

describe('java calls — end-to-end (runPass1 + runPass2)', () => {
  it('resolves a field call to the injected implementation method (high)', async () => {
    const i = await runPass1(
      'com/foo/UserService.java',
      'package com.foo;\npublic interface UserService { User findById(Long id); }',
      ctx()
    );
    const impl = await runPass1(
      'com/foo/UserServiceImpl.java',
      'package com.foo;\n@Service\nclass UserServiceImpl implements UserService { public User findById(Long id) { return null; } }',
      ctx()
    );
    const ctrl = await runPass1(
      'com/foo/UserController.java',
      [
        'package com.foo;',
        'class UserController {',
        '  @Autowired private UserService userService;',
        '  public User get(Long id) { return userService.findById(id); }',
        '}',
      ].join('\n'),
      ctx()
    );

    const own = [i, impl, ctrl];
    const r = runPass2(own, own, ctx());

    const call = r.resolvedEdges.find(
      (e) => e.type === 'calls' && e.from.includes('UserController') && e.from.includes('#get(')
    );
    expect(call?.to).toBe(
      'function:com/foo/UserServiceImpl.java:com.foo.UserServiceImpl#findById(java.lang.Long)'
    );
    expect(call?.meta?.confidence).toBe('high');
  });

  it('resolves an interface-method call as medium when no implementation exists', async () => {
    const mapper = await runPass1(
      'com/foo/Mapper.java',
      'package com.foo;\n@Mapper\npublic interface Mapper { int del(Long id); }',
      ctx()
    );
    const svc = await runPass1(
      'com/foo/Svc.java',
      [
        'package com.foo;',
        '@Service',
        'class Svc {',
        '  @Autowired private Mapper mapper;',
        '  void run(Long id) { mapper.del(id); }',
        '}',
      ].join('\n'),
      ctx()
    );

    const own = [mapper, svc];
    const r = runPass2(own, own, ctx());

    const call = r.resolvedEdges.find((e) => e.type === 'calls' && e.from.includes('#run('));
    expect(call?.to).toBe('function:com/foo/Mapper.java:com.foo.Mapper#del(java.lang.Long)');
    expect(call?.meta?.confidence).toBe('medium');
  });

  it('counts unresolved and emits no edge when the method is not found on the receiver', async () => {
    const svc = await runPass1(
      'com/foo/Svc.java',
      [
        'package com.foo;',
        'class Svc {',
        '  void run() { this.nope(); }',
        '}',
      ].join('\n'),
      ctx()
    );
    const own = [svc];
    const r = runPass2(own, own, ctx());

    expect(r.resolvedEdges.filter((e) => e.type === 'calls')).toHaveLength(0);
    expect(r.unresolvedCount).toBeGreaterThan(0);
  });

  it('fans out to Top-N implementations when receiver is an interface with multiple impls', async () => {
    const i = await runPass1(
      'com/foo/Svc.java',
      'package com.foo;\npublic interface Svc { void go(); }',
      ctx()
    );
    const a = await runPass1(
      'com/foo/SvcA.java',
      'package com.foo;\n@Service\nclass SvcA implements Svc { public void go() {} }',
      ctx()
    );
    const b = await runPass1(
      'com/foo/SvcB.java',
      'package com.foo;\n@Service\nclass SvcB implements Svc { public void go() {} }',
      ctx()
    );
    const c = await runPass1(
      'com/foo/C.java',
      [
        'package com.foo;',
        'class C {',
        '  @Autowired private Svc svc;',
        '  void run() { svc.go(); }',
        '}',
      ].join('\n'),
      ctx()
    );

    const own = [i, a, b, c];
    const r = runPass2(own, own, ctx());

    const goA = a.nodes.find((n) => n.type === 'function' && n.meta?.ownerType === 'com.foo.SvcA')!.id;
    const goB = b.nodes.find((n) => n.type === 'function' && n.meta?.ownerType === 'com.foo.SvcB')!.id;

    const calls = r.resolvedEdges.filter((e) => e.type === 'calls' && e.from.includes('#run('));
    expect(calls.map((e) => e.to).sort()).toEqual([goA, goB].sort());
    expect(calls.every((e) => e.meta?.confidence === 'low')).toBe(true);
    expect(calls.every((e) => e.meta?.reason === 'multipleImplementations')).toBe(true);
  });

  it('fan-out skips abstract implementations (no calls edge to a non-instantiable bean)', async () => {
    const i = await runPass1(
      'com/foo/Svc.java',
      'package com.foo;\npublic interface Svc { void go(); }',
      ctx()
    );
    const abs = await runPass1(
      'com/foo/AbstractSvc.java',
      'package com.foo;\npublic abstract class AbstractSvc implements Svc { public void go() {} }',
      ctx()
    );
    const a = await runPass1(
      'com/foo/SvcA.java',
      'package com.foo;\n@Service\nclass SvcA implements Svc { public void go() {} }',
      ctx()
    );
    const b = await runPass1(
      'com/foo/SvcB.java',
      'package com.foo;\n@Service\nclass SvcB implements Svc { public void go() {} }',
      ctx()
    );
    const c = await runPass1(
      'com/foo/C.java',
      'package com.foo;\nclass C { @Autowired private Svc svc; void run() { svc.go(); } }',
      ctx()
    );

    const own = [i, abs, a, b, c];
    const r = runPass2(own, own, ctx());

    const absGo = abs.nodes.find(
      (n) => n.type === 'function' && n.meta?.ownerType === 'com.foo.AbstractSvc'
    )!.id;
    const calls = r.resolvedEdges.filter((e) => e.type === 'calls' && e.from.includes('#run('));
    expect(calls.map((e) => e.to)).not.toContain(absGo);
    expect(calls).toHaveLength(2); // 仅两个具体实现
  });

  it('selects the right overload by argument count', async () => {
    const repo = await runPass1(
      'com/foo/Repo.java',
      [
        'package com.foo;',
        'class Repo {',
        '  void find(Long id) {}',
        '  void find(Long id, Long ver) {}',
        '  void caller() { find(x); }',
        '}',
      ].join('\n'),
      ctx()
    );
    const own = [repo];
    const r = runPass2(own, own, ctx());

    const calls = r.resolvedEdges.filter((e) => e.type === 'calls' && e.from.includes('#caller('));
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('function:com/foo/Repo.java:com.foo.Repo#find(java.lang.Long)');
  });
});
