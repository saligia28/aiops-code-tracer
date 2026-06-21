import { describe, it, expect } from 'vitest';
import type { GraphNode, GraphEdge } from '@aiops/shared-types';
import { formatNode, formatGraph, formatSearch, formatRepoStatus } from '../src/format.js';

const login: GraphNode = { id: 'function:src/user.ts:login', type: 'function', name: 'login', filePath: 'src/user.ts', loc: '88:2' };
const issue: GraphNode = { id: 'function:src/token.ts:issue', type: 'function', name: 'issue', filePath: 'src/token.ts', loc: '20:2' };
const edge: GraphEdge = { from: login.id, to: issue.id, type: 'calls', meta: { confidence: 'high' } };

describe('format', () => {
  it('formatNode renders name (type) — file:loc', () => {
    expect(formatNode(login)).toBe('login (function) — src/user.ts:88:2');
  });

  it('formatNode includes meta.kind when present', () => {
    const m: GraphNode = { ...login, type: 'function', meta: { kind: 'method' } };
    expect(formatNode(m)).toBe('login (function/method) — src/user.ts:88:2');
  });

  it('formatGraph resolves edge endpoints to names', () => {
    const out = formatGraph([login, issue], [edge]);
    expect(out).toContain('login --calls--> issue');
    expect(out).toContain('• login (function) — src/user.ts:88:2');
  });

  it('formatGraph marks non-high confidence', () => {
    const low: GraphEdge = { ...edge, meta: { confidence: 'low' } };
    expect(formatGraph([login, issue], [low])).toContain('--calls--> issue [low]');
  });

  it('formatGraph handles empty', () => {
    expect(formatGraph([], [])).toBe('（无结果）');
  });

  it('formatSearch lists hits with total', () => {
    const out = formatSearch('log', [login], 1);
    expect(out).toContain('命中 1 条');
    expect(out).toContain('• login (function) — src/user.ts:88:2');
  });

  it('formatSearch handles no results', () => {
    expect(formatSearch('zzz', [], 0)).toContain('未找到');
  });

  it('formatRepoStatus marks current repo and no-graph state', () => {
    const out = formatRepoStatus('demo', [{ repoName: 'demo', hasGraph: true, totalNodes: 10, totalEdges: 5 }]);
    expect(out).toContain('当前加载仓库：demo');
    expect(out).toContain('→ demo');
    expect(formatRepoStatus(null, [])).toContain('当前未加载任何仓库');
  });
});
