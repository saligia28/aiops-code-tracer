import { describe, it, expect } from 'vitest';
import type { AskResponse, GraphNode, GraphEdge } from '@aiops/shared-types';
import { formatNode, formatGraph, formatSearch, formatRepoStatus, formatAskResponse } from '../src/format.js';

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

  it('formatAskResponse renders answer, evidence, docs and graph summary compactly', () => {
    const response: AskResponse = {
      answer: '结论：保存后刷新列表。',
      evidence: [{ file: 'src/List.vue', line: 12, code: 'reloadList()', label: '状态刷新' }],
      docEvidence: [{
        docId: 'd1',
        title: '需求说明',
        source: 'docs/spec.md',
        snippet: '保存成功后需要刷新列表。',
        score: 0.9,
      }],
      graph: { nodes: [login], edges: [] },
      intent: 'CLICK_FLOW',
      confidence: 0.82,
      followUp: ['这个接口失败怎么处理？'],
      conversationId: 'c1',
    };

    const out = formatAskResponse('保存后做了什么？', response);
    expect(out).toContain('问题：保存后做了什么？');
    expect(out).toContain('意图：CLICK_FLOW');
    expect(out).toContain('src/List.vue:12');
    expect(out).toContain('需求说明');
    expect(out).toContain('login (function)');
    expect(out).toContain('这个接口失败怎么处理？');
  });

  it('formatAskResponse 的会话 fork 提示：仅在请求 id 与响应 id 不一致时出现', () => {
    const base: AskResponse = {
      answer: 'ok',
      evidence: [],
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: [],
      conversationId: 'real-id',
    };

    // 不一致 → 显式提示 + 指向新 id
    const forked = formatAskResponse('q', base, { requestedConversationId: 'dead-id' });
    expect(forked).toContain('已新开会话');
    expect(forked).toContain('dead-id');
    // 一致 → 无提示
    expect(formatAskResponse('q', base, { requestedConversationId: 'real-id' })).not.toContain('已新开会话');
    // 未请求复用（无状态问答）→ 无提示
    expect(formatAskResponse('q', base)).not.toContain('已新开会话');
  });
});
