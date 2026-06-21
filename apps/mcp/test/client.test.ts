import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzerGet, AnalyzerError } from '../src/client.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('analyzerGet', () => {
  it('returns parsed JSON on 200', async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await expect(analyzerGet('/api/repos')).resolves.toEqual({ ok: 1 });
  });

  it('builds query string, skipping undefined', async () => {
    const seen: string[] = [];
    stubFetch(async (input) => { seen.push(String(input)); return new Response('{}', { status: 200 }); });
    await analyzerGet('/api/search', { q: 'login', limit: undefined });
    expect(seen[0]).toContain('/api/search?q=login');
    expect(seen[0]).not.toContain('limit');
  });

  it('maps connection failure to a friendly AnalyzerError', async () => {
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(analyzerGet('/api/repos')).rejects.toBeInstanceOf(AnalyzerError);
    await analyzerGet('/api/repos').catch((e) => expect(e.message).toContain('分析服务'));
  });

  it('maps 503 to graph-not-loaded message', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'GRAPH_NOT_LOADED' }), { status: 503 }));
    await analyzerGet('/api/trace', { symbol: 'x' }).catch((e) => {
      expect(e).toBeInstanceOf(AnalyzerError);
      expect(e.message).toContain('未加载任何仓库');
    });
  });

  it('maps 400 to a params error', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'INVALID_PARAMS', message: '缺少 q' }), { status: 400 }));
    await analyzerGet('/api/search').catch((e) => expect(e.message).toContain('参数'));
  });
});
