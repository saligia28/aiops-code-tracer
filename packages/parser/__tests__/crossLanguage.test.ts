import { describe, it, expect } from 'vitest';
import type { GraphNode } from '@aiops/shared-types';
import { buildApiIndex } from '../src/symbolIndex.js';
import { buildCrossLanguageEdges } from '../src/crossLanguage.js';

const apiCall: GraphNode = {
  id: 'apiCall:web/api.ts:getUser',
  type: 'apiCall',
  name: 'getUser',
  filePath: 'web/api.ts',
  loc: '1:1',
  meta: { apiEndpoint: '/users/{id}', apiMethod: 'GET' },
};
const route: GraphNode = {
  id: 'routeEntry:U.java:GET /users/{id}',
  type: 'routeEntry',
  name: 'GET /users/{id}',
  filePath: 'U.java',
  loc: '1:1',
  meta: { apiEndpoint: '/users/{id}', apiMethod: 'GET' },
};

describe('crossLanguage — buildCrossLanguageEdges', () => {
  it('bridges client apiCall to server routeEntry on matching endpointKey', () => {
    const apiIndex = buildApiIndex([apiCall, route], []);
    const edges = buildCrossLanguageEdges(apiIndex);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: apiCall.id, to: route.id, type: 'calls' });
    expect(edges[0].meta?.confidence).toBe('medium');
    expect(edges[0].meta?.reason).toBe('crossLanguageEndpoint');
  });

  it('produces no edge when only one side is present', () => {
    expect(buildCrossLanguageEdges(buildApiIndex([route], []))).toEqual([]);
    expect(buildCrossLanguageEdges(buildApiIndex([apiCall], []))).toEqual([]);
  });

  it('caps fan-out per endpointKey at Top-N (3)', () => {
    const calls: GraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `apiCall:web/api.ts:c${i}`,
      type: 'apiCall',
      name: `c${i}`,
      filePath: 'web/api.ts',
      loc: `${i}:1`,
      meta: { apiEndpoint: '/x', apiMethod: 'GET' },
    }));
    const routes: GraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `routeEntry:S.java:GET /x#${i}`,
      type: 'routeEntry',
      name: `GET /x ${i}`,
      filePath: 'S.java',
      loc: `${i}:1`,
      meta: { apiEndpoint: '/x', apiMethod: 'GET' },
    }));
    const edges = buildCrossLanguageEdges(buildApiIndex([...calls, ...routes], []));
    // 每侧 cap 3 → 至多 3×3 = 9 条
    expect(edges.length).toBeLessThanOrEqual(9);
    expect(edges.length).toBeGreaterThan(0);
  });
});
