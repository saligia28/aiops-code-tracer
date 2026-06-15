import { describe, it, expect } from 'vitest';
import type { GraphNode, GraphEdge, RepoConfig } from '@aiops/shared-types';
import { buildSymbolIndex, buildRouteIndex } from '../src/symbolIndex.js';

function emptyConfig(): RepoConfig {
  return {
    repoName: 't',
    repoPath: '/tmp',
    scanPaths: [],
    excludePaths: [],
    aliases: {},
    autoImportDirs: [],
    framework: 'java',
    parsers: ['java'],
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
}

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

describe('buildRouteIndex — server routes', () => {
  it('emits serverRoute entries from routeEntry nodes + registersRoute edges', () => {
    const routeId = 'routeEntry:UserController.java:GET /users/{id}';
    const handlerId = 'function:UserController.java:com.foo.UserController#get(java.lang.Long)';
    const nodes: GraphNode[] = [
      {
        id: routeId,
        type: 'routeEntry',
        name: 'GET /users/{id}',
        filePath: 'UserController.java',
        loc: '5:3',
        meta: { apiEndpoint: '/users/{id}', apiMethod: 'GET' },
      },
      {
        id: handlerId,
        type: 'function',
        name: 'get',
        filePath: 'UserController.java',
        loc: '6:3',
        meta: { kind: 'method' },
      },
    ];
    const edges: GraphEdge[] = [
      { from: routeId, to: handlerId, type: 'registersRoute', loc: '5:3' },
    ];

    const result = buildRouteIndex(nodes, edges, emptyConfig());

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      routePath: '/users/{id}',
      httpMethod: 'GET',
      handlerNodeId: handlerId,
      kind: 'serverRoute',
      nodeId: routeId,
    });
  });

  it('returns empty routes when there are no routeEntry nodes', () => {
    const result = buildRouteIndex([], [], emptyConfig());
    expect(result.routes).toEqual([]);
  });
});
