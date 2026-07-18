import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  analyzerGet: vi.fn(),
  analyzerPost: vi.fn(),
  AnalyzerError: class extends Error {},
}));

import { analyzerGet, analyzerPost } from '../src/client.js';
import { searchSymbols } from '../src/tools/searchSymbols.js';
import { traceCallees } from '../src/tools/traceCallees.js';
import { traceCallers } from '../src/tools/traceCallers.js';
import { explainCodeLogic } from '../src/tools/explainCodeLogic.js';
import { allTools } from '../src/tools/index.js';

const mockGet = analyzerGet as unknown as ReturnType<typeof vi.fn>;
const mockPost = analyzerPost as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('tools', () => {
  it('exposes the MCP tools including task-level explanation', () => {
    expect(allTools.map((t) => t.name).sort()).toEqual(
      ['explain_code_logic', 'get_file_graph', 'get_symbol', 'repo_status', 'search_symbols', 'trace_callees', 'trace_callers'].sort(),
    );
  });

  it('search_symbols maps params to /api/search and formats', async () => {
    mockGet.mockResolvedValue({ query: 'login', total: 1, results: [{ id: 'function:a.ts:login', type: 'function', name: 'login', filePath: 'a.ts', loc: '1:0' }] });
    const out = await searchSymbols.handler({ q: 'login', limit: 10 });
    expect(mockGet).toHaveBeenCalledWith('/api/search', { q: 'login', limit: 10 });
    expect(out.content[0].text).toContain('login (function) — a.ts:1:0');
  });

  it('trace_callees hits /api/trace with symbol param', async () => {
    mockGet.mockResolvedValue({ symbol: 'x', nodeId: 'n', depth: 3, nodes: [], edges: [] });
    await traceCallees.handler({ symbol: 'x' });
    expect(mockGet).toHaveBeenCalledWith('/api/trace', { symbol: 'x', depth: undefined });
  });

  it('trace_callers hits /api/why with target param (symbol→target)', async () => {
    mockGet.mockResolvedValue({ target: 'x', nodeId: 'n', depth: 3, nodes: [], edges: [] });
    await traceCallers.handler({ symbol: 'x' });
    expect(mockGet).toHaveBeenCalledWith('/api/why', { target: 'x', depth: undefined });
  });

  it('handles SYMBOL_NOT_FOUND as a friendly non-error', async () => {
    mockGet.mockResolvedValue({ symbol: 'x', depth: 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' });
    const out = await traceCallees.handler({ symbol: 'x' });
    expect(out.content[0].text).toContain('未找到');
    expect(out.isError).toBeFalsy();
  });

  it('explain_code_logic posts to /api/ask with source:mcp and dedicated long timeout', async () => {
    mockPost.mockResolvedValue({
      answer: '结论：保存后刷新列表。',
      evidence: [{ file: 'src/List.vue', line: 12, code: 'reloadList()', label: '状态刷新' }],
      graph: { nodes: [], edges: [] },
      intent: 'CLICK_FLOW',
      confidence: 0.8,
      followUp: [],
      conversationId: 'c1',
    });

    const out = await explainCodeLogic.handler({ question: '保存后做了什么？', conversationId: 'c1' });

    // source:'mcp' = 服务端跳过记忆抽取/无 id 时不落库；timeoutMs = ask 专用长超时（默认 120s）
    expect(mockPost).toHaveBeenCalledWith(
      '/api/ask',
      { question: '保存后做了什么？', conversationId: 'c1', source: 'mcp' },
      { timeoutMs: 120_000 },
    );
    expect(out.content[0].text).toContain('保存后做了什么');
    expect(out.content[0].text).toContain('src/List.vue:12');
    // 请求 id 与响应 id 一致：不应出现"已新开会话"提示
    expect(out.content[0].text).not.toContain('已新开会话');
  });

  it('explain_code_logic 提示会话 fork：请求的 conversationId 与响应不一致时显式告知', async () => {
    mockPost.mockResolvedValue({
      answer: '结论：ok。',
      evidence: [],
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: [],
      conversationId: 'new-id',
    });

    const out = await explainCodeLogic.handler({ question: '继续上个话题', conversationId: 'stale-id' });
    expect(out.content[0].text).toContain('已新开会话');
    expect(out.content[0].text).toContain('new-id');
  });
});
