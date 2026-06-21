import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  analyzerGet: vi.fn(),
  AnalyzerError: class extends Error {},
}));

import { analyzerGet } from '../src/client.js';
import { searchSymbols } from '../src/tools/searchSymbols.js';
import { traceCallees } from '../src/tools/traceCallees.js';
import { traceCallers } from '../src/tools/traceCallers.js';
import { allTools } from '../src/tools/index.js';

const mockGet = analyzerGet as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => mockGet.mockReset());

describe('tools', () => {
  it('exposes exactly the 6 MVP tools', () => {
    expect(allTools.map((t) => t.name).sort()).toEqual(
      ['get_file_graph', 'get_symbol', 'repo_status', 'search_symbols', 'trace_callees', 'trace_callers'].sort(),
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
});
