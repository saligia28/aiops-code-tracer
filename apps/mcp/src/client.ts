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

async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new AnalyzerError(`查询超时（>${timeoutMs}ms）`);
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
    // 只有 401 才是密码错；重启/代理期间的 5xx 报"密码不正确"会误导用户去轮换正确密码（review 修复）
    if (res.status === 401) {
      throw new AnalyzerError('鉴权失败：ANALYZER_PASSWORD 密码不正确。');
    }
    throw new AnalyzerError(`登录失败：分析服务返回 ${res.status}（服务可能正在启动/重启，请稍后重试）。`);
  }
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/auth_token=([^;]+)/);
  // 认证未启用时 200 但无 cookie —— 视为无需鉴权。
  authCookie = m ? `auth_token=${m[1]}` : null;
}

/**
 * GET/POST 共享的请求核心：401 登录重试一次 + 错误映射 + JSON 解析。
 * makeInit 是 thunk——登录后 authCookie 变化，重试时要现拼 headers。
 * （此前 GET/POST 各持一份 22 行的逐字拷贝，review 实锤过漂移风险。）
 */
/** env 锁仓（P1-MCP 第三刀）：每次调用现读，测试可逐用例覆盖。 */
export function getRepoLock(): string {
  return (process.env.ANALYZER_REPO ?? '').trim();
}

/** 锁仓校验豁免路径：repos 查询自身（防递归）与登录。 */
function repoLockExempt(path: string): boolean {
  return path.startsWith('/api/repos') || path.startsWith('/api/auth');
}

/**
 * 锁仓 pre-check：MCP 与 Web 共享"当前仓库"，Web 端切库会让正在运行的模型任务
 * 静默拿到另一个仓库的结论。设置 ANALYZER_REPO 后，每次请求先核对当前仓库，
 * 不一致直接报错（比"结果可能来自错误仓库"的事后提示强一档）。
 * 竞态窗口（校验后、请求完成前切库）由 ask 工具的 response.repoName post-check 兜底。
 */
async function assertRepoLock(): Promise<void> {
  const lock = getRepoLock();
  if (!lock) return;
  const data = await requestJson<{ currentRepo: string | null }>(
    new URL(BASE_URL + '/api/repos'),
    '/api/repos',
    () => (authCookie ? { headers: { cookie: authCookie } } : undefined),
  );
  if (data.currentRepo !== lock) {
    throw new AnalyzerError(
      `仓库锁定不匹配：MCP 锁定分析 ${lock}（env ANALYZER_REPO），但分析服务当前加载的是 ${data.currentRepo ?? '（无）'}。` +
        `请在 Web 界面切回 ${lock} 后重试，或调整/移除 ANALYZER_REPO。`,
    );
  }
}

async function requestJson<T>(
  url: string | URL,
  path: string,
  makeInit: () => RequestInit | undefined,
  timeoutMs?: number,
): Promise<T> {
  if (!repoLockExempt(path)) await assertRepoLock();
  const doFetch = () => fetchWithTimeout(url, makeInit(), timeoutMs);

  let res = await doFetch();

  // 401：若配置了密码，则登录后重试一次。
  if (res.status === 401 && process.env.ANALYZER_PASSWORD) {
    await login();
    res = await doFetch();
  }

  if (!res.ok) {
    let payload: { error?: string; message?: string } | null = null;
    try {
      payload = (await res.json()) as { error?: string; message?: string };
    } catch {
      /* non-JSON body */
    }

    if (res.status === 401) {
      throw new AnalyzerError(
        'API 需要鉴权。请在 MCP 配置的 env 里设置正确的 ANALYZER_PASSWORD。',
      );
    }
    if (res.status === 503 || payload?.error === 'GRAPH_NOT_LOADED') {
      throw new AnalyzerError('当前未加载任何仓库。请先在 Web 界面选中一个项目，再重试。');
    }
    if (res.status === 400) {
      throw new AnalyzerError(`参数错误：${payload?.message ?? path}`);
    }
    throw new AnalyzerError(`分析服务返回 ${res.status}：${payload?.message ?? res.statusText}`);
  }

  // 200 但非 JSON（反代兜底页等）：转成可行动的 AnalyzerError，而非裸 SyntaxError（review 修复）
  try {
    return (await res.json()) as T;
  } catch {
    throw new AnalyzerError(`分析服务返回了非 JSON 响应（${path}）。请检查 ANALYZER_BASE_URL 是否指向分析 API 本体。`);
  }
}

export async function analyzerGet<T = unknown>(path: string, query: Query = {}): Promise<T> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return requestJson<T>(url, path, () => (authCookie ? { headers: { cookie: authCookie } } : undefined));
}

export async function analyzerPost<T = unknown>(
  path: string,
  body: unknown,
  opts: {
    /**
     * 单次调用超时覆盖。全局 ANALYZER_TIMEOUT_MS（默认 30s）按快速图谱查询校准，
     * 走 LLM 管线的端点（/api/ask 最多 3-4 次串行 LLM 调用）必须传更长的预算，
     * 否则客户端超时后服务端仍会跑完全程白白计费（review 修复）。
     */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  return requestJson<T>(
    BASE_URL + path,
    path,
    () => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authCookie) headers.cookie = authCookie;
      return { method: 'POST', headers, body: JSON.stringify(body) };
    },
    opts.timeoutMs,
  );
}
