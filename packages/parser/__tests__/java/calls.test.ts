import { describe, it, expect } from 'vitest';
import { inferReceiverType } from '../../src/languages/java/callResolver.js';
import type { ReceiverScope } from '../../src/languages/java/callResolver.js';
import { buildTypeRegistry } from '../../src/languages/java/typeResolver.js';

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
