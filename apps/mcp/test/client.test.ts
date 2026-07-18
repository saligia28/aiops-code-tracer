import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzerGet, analyzerPost, AnalyzerError, __resetAuthForTests } from '../src/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAuthForTests();
});

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

  it('with ANALYZER_PASSWORD, logs in on 401 then retries with the cookie', async () => {
    vi.stubEnv('ANALYZER_PASSWORD', 'pw');
    const calls: Array<{ url: string; cookie?: string }> = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      const cookie = (init as RequestInit | undefined)?.headers
        ? ((init as RequestInit).headers as Record<string, string>).cookie
        : undefined;
      calls.push({ url, cookie });
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'set-cookie': 'auth_token=TOKEN123; Path=/; HttpOnly' },
        });
      }
      if (cookie === 'auth_token=TOKEN123') {
        return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: '未授权，请先登录' }), { status: 401 });
    });
    await expect(analyzerGet('/api/repos')).resolves.toEqual({ ok: 1 });
    expect(calls.some((c) => c.url.includes('/api/auth/login'))).toBe(true);
    expect(calls.some((c) => c.cookie === 'auth_token=TOKEN123')).toBe(true);
  });

  it('401 without ANALYZER_PASSWORD → actionable error mentioning ANALYZER_PASSWORD', async () => {
    vi.stubEnv('ANALYZER_PASSWORD', '');
    stubFetch(async () => new Response(JSON.stringify({ message: '未授权' }), { status: 401 }));
    await analyzerGet('/api/repos').catch((e) => {
      expect(e).toBeInstanceOf(AnalyzerError);
      expect(e.message).toContain('ANALYZER_PASSWORD');
    });
  });

  it('wrong password → login fails with a clear error', async () => {
    vi.stubEnv('ANALYZER_PASSWORD', 'wrong');
    stubFetch(async (input) => {
      if (String(input).includes('/api/auth/login')) {
        return new Response(JSON.stringify({ message: '密码错误' }), { status: 401 });
      }
      return new Response(JSON.stringify({ message: '未授权' }), { status: 401 });
    });
    await analyzerGet('/api/repos').catch((e) => {
      expect(e).toBeInstanceOf(AnalyzerError);
      expect(e.message).toContain('密码不正确');
    });
  });

  it('POST sends JSON body and returns parsed JSON', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    stubFetch(async (input, init) => {
      seen.push({ url: String(input), method: init?.method, body: init?.body as string | undefined });
      return new Response(JSON.stringify({ answer: 'ok' }), { status: 200 });
    });

    await expect(analyzerPost('/api/ask', { question: 'q' })).resolves.toEqual({ answer: 'ok' });
    expect(seen[0].url).toContain('/api/ask');
    expect(seen[0].method).toBe('POST');
    expect(JSON.parse(seen[0].body ?? '{}')).toEqual({ question: 'q' });
  });

  it('POST logs in on 401 then retries with cookie', async () => {
    vi.stubEnv('ANALYZER_PASSWORD', 'pw');
    const calls: Array<{ url: string; cookie?: string }> = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      calls.push({ url, cookie: headers?.cookie });
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'set-cookie': 'auth_token=TOKEN456; Path=/; HttpOnly' },
        });
      }
      if (headers?.cookie === 'auth_token=TOKEN456') {
        return new Response(JSON.stringify({ answer: 'ok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: '未授权' }), { status: 401 });
    });

    await expect(analyzerPost('/api/ask', { question: 'q' })).resolves.toEqual({ answer: 'ok' });
    expect(calls.some((c) => c.url.includes('/api/auth/login'))).toBe(true);
    expect(calls.some((c) => c.cookie === 'auth_token=TOKEN456')).toBe(true);
  });

  it('POST honors per-call timeoutMs override（LLM 端点专用长/短预算）', async () => {
    // 永不 resolve、只响应 abort 的 fetch：超时路径必须由 timeoutMs 触发
    stubFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }) as ReturnType<typeof fetch>,
    );
    await expect(analyzerPost('/api/ask', { question: 'q' }, { timeoutMs: 20 })).rejects.toThrow('查询超时（>20ms）');
  });
});
