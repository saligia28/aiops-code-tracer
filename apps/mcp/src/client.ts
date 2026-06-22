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

// 鉴权：API 开启 AUTH_PASSWORD 时，非公开路由需携带 auth_token cookie。
// token = HMAC(每次启动随机的 AUTH_SECRET, 密码)，无法预先计算 —— 必须先登录拿 cookie。
let authCookie: string | null = null;

/** 仅供测试：重置模块级 cookie 状态。 */
export function __resetAuthForTests(): void {
  authCookie = null;
}

async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AnalyzerError(`查询超时（>${TIMEOUT_MS}ms）`);
    }
    throw new AnalyzerError(`分析服务不可达（${BASE_URL}）。请确认 API 已启动：pnpm dev:api`);
  } finally {
    clearTimeout(timer);
  }
}

/** 用 ANALYZER_PASSWORD 登录，存下 auth_token cookie。失败抛 AnalyzerError。 */
async function login(): Promise<void> {
  const password = process.env.ANALYZER_PASSWORD;
  if (!password) {
    throw new AnalyzerError(
      'API 需要鉴权，但未配置密码。请在 MCP 配置的 env 里设置 ANALYZER_PASSWORD。',
    );
  }
  const res = await fetchWithTimeout(BASE_URL + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw new AnalyzerError('鉴权失败：ANALYZER_PASSWORD 密码不正确。');
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/auth_token=([^;]+)/);
  // 认证未启用时 200 但无 cookie —— 视为无需鉴权。
  authCookie = m ? `auth_token=${m[1]}` : null;
}

export async function analyzerGet<T = unknown>(path: string, query: Query = {}): Promise<T> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const doFetch = () =>
    fetchWithTimeout(url, authCookie ? { headers: { cookie: authCookie } } : undefined);

  let res = await doFetch();

  // 401：若配置了密码，则登录后重试一次。
  if (res.status === 401 && process.env.ANALYZER_PASSWORD) {
    await login();
    res = await doFetch();
  }

  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = (await res.json()) as { error?: string; message?: string };
    } catch {
      /* non-JSON body */
    }

    if (res.status === 401) {
      throw new AnalyzerError(
        'API 需要鉴权。请在 MCP 配置的 env 里设置正确的 ANALYZER_PASSWORD。',
      );
    }
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
