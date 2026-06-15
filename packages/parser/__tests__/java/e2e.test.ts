import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RepoConfig } from '@aiops/shared-types';
import { collectFiles } from '../../src/scanner/fileCollector.js';
import { buildGraph } from '../../src/graphBuilder.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../fixtures/spring-sample');

function javaConfig(): RepoConfig {
  return {
    repoName: 'spring-sample',
    repoPath: REPO,
    scanPaths: ['src/main/java'],
    excludePaths: ['src/test/**'],
    aliases: {},
    autoImportDirs: [],
    framework: 'java',
    parsers: ['java'],
    stateManagement: 'none',
    scriptStyle: 'composition',
  };
}

describe('java e2e — spring sample', () => {
  it('builds an OOP graph with classes/interfaces/methods/fields/routes + resolved edges', async () => {
    const config = javaConfig();
    const files = await collectFiles(config);
    expect(files).toHaveLength(5);

    const result = await buildGraph(files, config);
    const nodes = result.graph.getAllNodes();
    const edges = result.graph.getAllEdges();

    const byType = (t: string) => nodes.filter((n) => n.type === t);
    const named = (t: string, name: string) => nodes.find((n) => n.type === t && n.name === name);

    // 类型节点
    expect(byType('class').map((n) => n.name).sort()).toEqual([
      'User',
      'UserController',
      'UserServiceImpl',
    ]);
    expect(byType('interface').map((n) => n.name).sort()).toEqual(['UserMapper', 'UserService']);

    // Spring stereotype
    expect(named('class', 'UserController')?.meta?.springStereotype).toBe('controller');
    expect(named('class', 'UserServiceImpl')?.meta?.springStereotype).toBe('service');

    // 方法 / 字段 / 路由数量
    expect(byType('function').length).toBeGreaterThanOrEqual(5);
    expect(byType('variable').length).toBeGreaterThanOrEqual(4);
    expect(byType('routeEntry')).toHaveLength(2);

    // implements: UserServiceImpl → UserService
    const implId = named('class', 'UserServiceImpl')!.id;
    const ifaceId = named('interface', 'UserService')!.id;
    expect(edges.some((e) => e.type === 'implements' && e.from === implId && e.to === ifaceId)).toBe(
      true
    );

    // injects: controller 字段 → UserService 的唯一实现 UserServiceImpl（Phase 2：解析到实现类，high）
    const controllerField = nodes.find((n) => n.type === 'variable' && n.name === 'userService');
    const injectEdge = edges.find((e) => e.type === 'injects' && e.from === controllerField?.id);
    expect(injectEdge?.to).toBe(implId);
    expect(injectEdge?.meta?.declaredType).toBe('com.demo.UserService');
    expect(injectEdge?.meta?.confidence).toBe('high');

    // defines: 类定义其方法
    const getById = nodes.find((n) => n.type === 'function' && n.name === 'getById');
    const controllerId = named('class', 'UserController')!.id;
    expect(
      edges.some((e) => e.type === 'defines' && e.from === controllerId && e.to === getById?.id)
    ).toBe(true);

    // registersRoute
    expect(edges.filter((e) => e.type === 'registersRoute')).toHaveLength(2);

    // routeIndex serverRoute
    const serverRoutes = result.routeIndex.routes.filter((r) => r.kind === 'serverRoute');
    expect(serverRoutes).toHaveLength(2);
    expect(serverRoutes.map((r) => r.routePath).sort()).toEqual(['/users', '/users/{id}']);
    expect(serverRoutes.every((r) => !!r.handlerNodeId)).toBe(true);

    // 统计
    expect(result.stats.totalNodes).toBeGreaterThan(0);
    expect(result.stats.failedFiles).toEqual([]);
  });
});
