import { describe, it, expect } from 'vitest';
import { runPass1 } from '../../src/languages/java/pass1.js';
import type { JavaParserData } from '../../src/languages/java/types.js';
import { ctx } from './helpers.js';

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

describe('java pass1 — field + injection', () => {
  it('extracts @Autowired field with defines edge and inject pendingRef', async () => {
    const src = [
      'package com.foo;',
      'public class UserController {',
      '  @Autowired',
      '  private UserService userService;',
      '}',
    ].join('\n');

    const result = await runPass1('UserController.java', src, ctx());
    const data = result.parserData as JavaParserData;

    const field = result.nodes.find((n) => n.type === 'variable' && n.name === 'userService');
    expect(field?.id).toBe('variable:UserController.java:com.foo.UserController#userService');
    expect(field?.meta?.kind).toBe('field');
    expect(field?.meta?.fieldType).toBe('UserService');
    expect(field?.meta?.visibility).toBe('private');
    expect(field?.meta?.annotations).toEqual(['@Autowired']);
    expect(field?.meta?.ownerType).toBe('com.foo.UserController');

    const defines = result.edges.find((e) => e.type === 'defines' && e.to === field?.id);
    expect(defines?.from).toBe('class:UserController.java:com.foo.UserController');

    const inject = data.pendingRefs.find((r) => r.kind === 'inject');
    expect(inject).toMatchObject({
      kind: 'inject',
      fromFieldNodeId: field?.id,
      declaredType: 'UserService',
    });

    expect(data.typeEnv.fieldTypes['userService']).toBe('UserService');
  });

  it('captures @Qualifier and unwraps the DI container to the inner bean type', async () => {
    const src = [
      'package com.foo;',
      'class C {',
      '  @Autowired @Qualifier("primary")',
      '  private List<Repo> repos;',
      '}',
    ].join('\n');

    const result = await runPass1('C.java', src, ctx());
    const data = result.parserData as JavaParserData;

    const field = result.nodes.find((n) => n.name === 'repos');
    expect(field?.meta?.fieldType).toBe('Repo'); // List<Repo> 解包为内层 bean 类型

    const inject = data.pendingRefs.find((r) => r.kind === 'inject');
    expect(inject).toMatchObject({ declaredType: 'Repo', qualifier: 'primary' });
  });

  it('does not create inject pendingRef for plain (non-annotated) field', async () => {
    const src = ['package com.foo;', 'class C {', '  private int count;', '}'].join('\n');
    const result = await runPass1('C.java', src, ctx());
    const data = result.parserData as JavaParserData;
    expect(data.pendingRefs.some((r) => r.kind === 'inject')).toBe(false);
    const field = result.nodes.find((n) => n.name === 'count');
    expect(field?.meta?.visibility).toBe('private');
  });
});

describe('java pass1 — methods', () => {
  it('emits overload-safe method ids with signature/returnType/paramTypes + defines', async () => {
    const src = [
      'package com.foo;',
      'public class UserService {',
      '  public User findById(Long id) { return null; }',
      '  public User findById(String s) { return null; }',
      '}',
    ].join('\n');

    const result = await runPass1('UserService.java', src, ctx());

    const methods = result.nodes.filter((n) => n.type === 'function' && n.name === 'findById');
    expect(methods).toHaveLength(2);
    expect(methods.map((m) => m.id).sort()).toEqual([
      'function:UserService.java:com.foo.UserService#findById(java.lang.Long)',
      'function:UserService.java:com.foo.UserService#findById(java.lang.String)',
    ]);

    const byLong = methods.find((m) => m.id.includes('Long'));
    expect(byLong?.meta?.kind).toBe('method');
    expect(byLong?.meta?.returnType).toBe('User');
    expect(byLong?.meta?.paramTypes).toEqual(['java.lang.Long']);
    expect(byLong?.meta?.visibility).toBe('public');
    expect(byLong?.meta?.signature).toBe('findById(java.lang.Long)');

    expect(
      result.edges.some(
        (e) =>
          e.type === 'defines' &&
          e.from === 'class:UserService.java:com.foo.UserService' &&
          e.to === byLong?.id
      )
    ).toBe(true);
  });

  it('handles constructors and zero-arg methods', async () => {
    const src = ['package com.foo;', 'class C {', '  C() {}', '  void noArgs() {}', '}'].join('\n');
    const result = await runPass1('C.java', src, ctx());

    const ctor = result.nodes.find((n) => n.type === 'function' && n.name === 'C');
    expect(ctor?.id).toBe('function:C.java:com.foo.C#C()');

    const noArgs = result.nodes.find((n) => n.name === 'noArgs');
    expect(noArgs?.id).toBe('function:C.java:com.foo.C#noArgs()');
    expect(noArgs?.meta?.returnType).toBe('void');
  });
});

describe('java pass1 — spring routes', () => {
  it('composes class base path + method mapping into routeEntry + registersRoute', async () => {
    const src = [
      'package com.foo;',
      '@RestController',
      '@RequestMapping("/users")',
      'public class UserController {',
      '  @GetMapping("/{id}")',
      '  public User get(Long id) { return null; }',
      '  @PostMapping',
      '  public void create() {}',
      '}',
    ].join('\n');

    const result = await runPass1('UserController.java', src, ctx());

    const routes = result.nodes.filter((n) => n.type === 'routeEntry');
    expect(routes).toHaveLength(2);

    const getRoute = routes.find((r) => r.meta?.apiMethod === 'GET');
    expect(getRoute?.meta?.apiEndpoint).toBe('/users/{id}');

    const postRoute = routes.find((r) => r.meta?.apiMethod === 'POST');
    expect(postRoute?.meta?.apiEndpoint).toBe('/users');

    const getMethod = result.nodes.find((n) => n.type === 'function' && n.name === 'get');
    expect(
      result.edges.some(
        (e) =>
          e.type === 'registersRoute' && e.from === getRoute?.id && e.to === getMethod?.id
      )
    ).toBe(true);
  });

  it('fills typeEnv.localVarTypes scoped by methodNodeId (params + local declarations)', async () => {
    const src = [
      'package com.foo;',
      'class C {',
      '  void m(UserService s) { User u = build(); int n = 0; }',
      '}',
    ].join('\n');

    const result = await runPass1('C.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const m = result.nodes.find((n) => n.type === 'function' && n.name === 'm')!;

    expect(data.typeEnv.localVarTypes[m.id]).toMatchObject({ s: 'UserService', u: 'User', n: 'int' });
  });

  it('scopes same-named locals separately per method', async () => {
    const src = [
      'package com.foo;',
      'class C {',
      '  void a() { Foo x = f(); }',
      '  void b() { Bar x = g(); }',
      '}',
    ].join('\n');

    const result = await runPass1('C.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const a = result.nodes.find((n) => n.name === 'a')!;
    const b = result.nodes.find((n) => n.name === 'b')!;

    expect(data.typeEnv.localVarTypes[a.id]?.x).toBe('Foo');
    expect(data.typeEnv.localVarTypes[b.id]?.x).toBe('Bar');
  });

  it('supports @RequestMapping(method=RequestMethod.POST) at method level', async () => {
    const src = [
      'package com.foo;',
      '@RequestMapping("/api")',
      'class C {',
      '  @RequestMapping(value = "/save", method = RequestMethod.POST)',
      '  void save() {}',
      '}',
    ].join('\n');

    const result = await runPass1('C.java', src, ctx());
    const route = result.nodes.find((n) => n.type === 'routeEntry');
    expect(route?.meta?.apiMethod).toBe('POST');
    expect(route?.meta?.apiEndpoint).toBe('/api/save');
  });
});

describe('java pass1 — generic DI container injection unwrap', () => {
  const injects = (data: JavaParserData) =>
    data.pendingRefs.filter(
      (r): r is Extract<JavaParserData['pendingRefs'][number], { kind: 'inject' }> =>
        r.kind === 'inject'
    );

  it('unwraps Provider<T> / Optional<T> to the inner bean type', async () => {
    const src = [
      'package com.foo;',
      'class C {',
      '  @Autowired private Provider<Svc> p;',
      '  @Autowired private Optional<Repo> r;',
      '}',
    ].join('\n');
    const result = await runPass1('C.java', src, ctx());
    expect(
      injects(result.parserData as JavaParserData)
        .map((i) => i.declaredType)
        .sort()
    ).toEqual(['Repo', 'Svc']);
  });

  it('unwraps List<T> to the inner bean type', async () => {
    const src = ['package com.foo;', 'class C { @Autowired private List<Svc> all; }'].join('\n');
    const result = await runPass1('C.java', src, ctx());
    const inj = injects(result.parserData as JavaParserData);
    expect(inj).toHaveLength(1);
    expect(inj[0].declaredType).toBe('Svc');
  });
});

describe('java pass1 — method-body calls', () => {
  it('collects method-body calls as pendingRefs(call) with receiver/name/argCount', async () => {
    const src = [
      'package com.foo;',
      'class C {',
      '  @Autowired Svc svc;',
      '  void m() { svc.go(1); this.help(); bare(); }',
      '}',
    ].join('\n');

    const result = await runPass1('C.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const m = result.nodes.find((n) => n.type === 'function' && n.name === 'm')!;

    const calls = data.pendingRefs.filter(
      (r): r is Extract<JavaParserData['pendingRefs'][number], { kind: 'call' }> => r.kind === 'call'
    );

    expect(calls.map((c) => c.methodName).sort()).toEqual(['bare', 'go', 'help']);

    const byName = (name: string) => calls.find((c) => c.methodName === name)!;
    expect(byName('go').receiverExpr).toBe('svc');
    expect(byName('go').argCount).toBe(1);
    expect(byName('go').fromMethodNodeId).toBe(m.id);
    expect(byName('help').receiverExpr).toBe('this');
    expect(byName('bare').receiverExpr).toBe('');
    expect(byName('bare').argCount).toBe(0);
  });
});

describe('java pass1 — constructor injection', () => {
  const injects = (data: JavaParserData) =>
    data.pendingRefs.filter(
      (r): r is Extract<JavaParserData['pendingRefs'][number], { kind: 'inject' }> =>
        r.kind === 'inject'
    );

  it('treats a sole constructor param (same-named field) as injection', async () => {
    const src = [
      'package com.foo;',
      '@Service',
      'class Foo {',
      '  private final Bar bar;',
      '  Foo(Bar bar) { this.bar = bar; }',
      '}',
    ].join('\n');

    const result = await runPass1('Foo.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const field = result.nodes.find((n) => n.type === 'variable' && n.name === 'bar')!;

    const inj = injects(data);
    expect(inj).toHaveLength(1);
    expect(inj[0].fromFieldNodeId).toBe(field.id);
    expect(inj[0].declaredType).toBe('Bar');
  });

  it('treats @Autowired constructor params as injection (multi-arg)', async () => {
    const src = [
      'package com.foo;',
      'class Foo {',
      '  private Bar bar;',
      '  private Baz baz;',
      '  Foo() {}',
      '  @Autowired Foo(Bar bar, Baz baz) { this.bar = bar; this.baz = baz; }',
      '}',
    ].join('\n');

    const result = await runPass1('Foo.java', src, ctx());
    const data = result.parserData as JavaParserData;

    const types = injects(data)
      .map((r) => r.declaredType)
      .sort();
    expect(types).toEqual(['Bar', 'Baz']);
  });

  it('does not inject when there are multiple un-annotated constructors', async () => {
    const src = [
      'package com.foo;',
      'class Foo {',
      '  private Bar bar;',
      '  Foo() {}',
      '  Foo(Bar bar) { this.bar = bar; }',
      '}',
    ].join('\n');

    const result = await runPass1('Foo.java', src, ctx());
    const data = result.parserData as JavaParserData;
    expect(injects(data)).toHaveLength(0);
  });

  it('resolves this.field=param assignment when field name differs from param name', async () => {
    const src = [
      'package com.foo;',
      '@Service',
      'class Foo {',
      '  private final Bar barService;',
      '  Foo(Bar bar) { this.barService = bar; }',
      '}',
    ].join('\n');

    const result = await runPass1('Foo.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const field = result.nodes.find((n) => n.type === 'variable' && n.name === 'barService')!;

    const inj = injects(data);
    expect(inj).toHaveLength(1);
    expect(inj[0].fromFieldNodeId).toBe(field.id);
    expect(inj[0].declaredType).toBe('Bar');
  });

  it('captures @Qualifier on a constructor parameter', async () => {
    const src = [
      'package com.foo;',
      '@Service',
      'class Foo {',
      '  private Bar bar;',
      '  Foo(@Qualifier("primary") Bar bar) { this.bar = bar; }',
      '}',
    ].join('\n');

    const result = await runPass1('Foo.java', src, ctx());
    const data = result.parserData as JavaParserData;
    const inj = injects(data);
    expect(inj).toHaveLength(1);
    expect(inj[0].qualifier).toBe('primary');
  });
});
