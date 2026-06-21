const BASE_URL = (process.env.ANALYZER_BASE_URL ?? 'http://localhost:4201').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.ANALYZER_TIMEOUT_MS) || 30000;

/** Error whose message is safe + actionable to surface directly to Claude Code. */
export class AnalyzerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzerError';
  }
}

export type Query = Record<string, string | number | undefined>;

export async function analyzerGet<T = unknown>(path: string, query: Query = {}): Promise<T> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AnalyzerError(`查询超时（>${TIMEOUT_MS}ms）：${path}`);
    }
    throw new AnalyzerError(`分析服务不可达（${BASE_URL}）。请确认 API 已启动：pnpm dev:api`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    type ApiBody = { error?: string; message?: string };
    let body: ApiBody | null = null;
    try { body = (await res.json()) as ApiBody; } catch { /* non-JSON body */ }

    if (res.status === 503 || body?.error === 'GRAPH_NOT_LOADED') {
      throw new AnalyzerError('当前未加载任何仓库。请先在 Web 界面选中一个项目，再重试。');
    }
    if (res.status === 400) {
      throw new AnalyzerError(`参数错误：${body?.message ?? path}`);
    }
    throw new AnalyzerError(`分析服务返回 ${res.status}：${body?.message ?? res.statusText}`);
  }

  return (await res.json()) as T;
}
