import { describe, it, expect } from 'vitest';
import type { GraphNode } from '@aiops/shared-types';
import { buildSymbolIndex } from '../src/symbolIndex.js';

describe('symbolIndex', () => {
  it('应支持与原型链同名的符号名', () => {
    const nodes: GraphNode[] = [
      {
        id: 'function:src/a.ts:constructor',
        type: 'function',
        name: 'constructor',
        filePath: 'src/a.ts',
        loc: '1:1',
      },
      {
        id: 'function:src/b.ts:__proto__',
        type: 'function',
        name: '__proto__',
        filePath: 'src/b.ts',
        loc: '2:1',
      },
      {
        id: 'function:src/c.ts:toString',
        type: 'function',
        name: 'toString',
        filePath: 'src/c.ts',
        loc: '3:1',
      },
    ];

    const result = buildSymbolIndex(nodes);

    expect(result.symbols['constructor']).toHaveLength(1);
    expect(result.symbols['constructor'][0]?.nodeId).toBe('function:src/a.ts:constructor');
    expect(result.symbols['__proto__']).toHaveLength(1);
    expect(result.symbols['__proto__'][0]?.nodeId).toBe('function:src/b.ts:__proto__');
    expect(result.symbols['toString']).toHaveLength(1);
    expect(result.symbols['toString'][0]?.nodeId).toBe('function:src/c.ts:toString');
  });
});
