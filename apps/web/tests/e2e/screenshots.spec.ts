import { test, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Quiet Grid 双主题截图矩阵（QA 产物，非断言）。
 *
 * 复用 quiet-grid-layout.spec.ts 的同款 mock（长项目名/长模型名/就绪索引 +
 * WebSocket 挂起桩），只为渲染出稳定的首屏；不伪造任何业务成功流。
 * 主题在首帧前由 localStorage 强制（index.html 内联脚本读 'theme' 键，
 * 优先级高于系统 prefers-color-scheme），因此 light/dark 完全确定。
 *
 * 输出到仓库根 design-qa/quiet-grid/screenshots/，供人工目视核验换肤效果。
 */

// ---------- 布局压力用的稳定 mock 数据（与 quiet-grid-layout.spec.ts 一致） ----------
const LONG_PROJECT_NAME = 'aiops-code-tracer-with-an-extremely-long-project-name';
const LONG_MODEL_NAME = 'deepseek-v4-flash-preview-extended-context';

const PROJECTS = [
  {
    id: 'p-long',
    name: LONG_PROJECT_NAME,
    framework: 'vue3',
    repoPath: '/repo/long',
    gitUrl: '',
    scanPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    hasGraph: true,
    totalNodes: 12345,
    totalEdges: 67890,
    lastBuildTime: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'p-demo',
    name: 'demo-app',
    framework: 'react',
    repoPath: '/repo/demo',
    gitUrl: '',
    scanPaths: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    hasGraph: false,
  },
];

const LLM_CONFIG = {
  mode: 'api',
  provider: 'deepseek',
  model: LONG_MODEL_NAME,
  baseUrl: 'https://api.deepseek.example.com/v1',
  availableModes: [
    { value: 'api', label: 'API / 默认' },
    { value: 'intranet', label: '内网 Ollama' },
  ],
  availableModels: [
    { value: LONG_MODEL_NAME, label: LONG_MODEL_NAME },
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
  ],
  apiProvider: 'deepseek',
  apiModel: LONG_MODEL_NAME,
  apiBaseUrl: 'https://api.deepseek.example.com/v1',
  intranetModel: 'qwen2.5-coder:7b',
  intranetBaseUrl: 'http://127.0.0.1:11434',
  intranetEnabled: true,
};

const INDEX_STATUS = {
  status: 'ready',
  repoName: LONG_PROJECT_NAME,
  totalFiles: 428,
  totalNodes: 12345,
  totalEdges: 67890,
  lastBuildTime: '2026-01-01T00:00:00.000Z',
};

// ---------- mock 安装（API + WebSocket），与 quiet-grid-layout.spec.ts 一致 ----------
async function installMocks(page: Page): Promise<void> {
  // WebSocket：接受并挂起空连接（不回连真实服务端、不下发消息）。
  await page.routeWebSocket(/\/ws\//, () => {
    /* 故意留空：纯客户端挂起连接 */
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    switch (path) {
      case '/api/auth/status':
        return json({ authenticated: true, authEnabled: true });
      case '/api/projects':
        return json({ currentProjectId: PROJECTS[0].id, projects: PROJECTS });
      case '/api/llm/config':
        return json(LLM_CONFIG);
      case '/api/index/status':
        return json(INDEX_STATUS);
      case '/api/conversations':
        return json([]);
      case '/api/memories':
        return json([]);
      default:
        return json({});
    }
  });
}

// ---------- 路由根元素（等待渲染稳定） ----------
const ROOT_SELECTOR: Record<string, string> = {
  '/': '.home',
  '/login': '.login-page',
  '/answer': '.answer-page',
  '/graph': '.graph-explorer',
  '/index-manager': '.index-manager',
  '/propose-patch': '.propose',
};

// ---------- 输出目录（锚定仓库根，而非 playwright 的 cwd=apps/web） ----------
// 本包为原生 ESM，无 __dirname；用 import.meta.url 还原当前文件目录：
// <root>/apps/web/tests/e2e → 上溯 4 层到仓库根。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const SHOT_DIR = path.join(REPO_ROOT, 'design-qa/quiet-grid/screenshots');

const THEMES = ['light', 'dark'] as const;
const ROUTES = ['/', '/login', '/answer', '/graph', '/index-manager', '/propose-patch'];
const MOBILE_ROUTES = ['/', '/answer', '/login'];
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** '/'→'home'，其余去掉前导斜杠。 */
function slug(route: string): string {
  return route === '/' ? 'home' : route.replace(/^\//, '');
}

/** 强制主题 → 装 mock → 定视口 → 导航 → 等根元素 → 关动画 → settle 一帧 → 全页截图。 */
async function capture(
  page: Page,
  theme: (typeof THEMES)[number],
  route: string,
  viewport: { width: number; height: number },
  kind: 'desktop' | 'mobile',
): Promise<void> {
  // 首帧前写入 localStorage['theme']；addInitScript 在页面自身脚本前执行，
  // 故 index.html 内联主题脚本读到的即是这里强制的值。
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('theme', t as string);
    } catch {
      /* localStorage 不可用时静默降级到系统主题 */
    }
  }, theme);

  await installMocks(page);
  await page.setViewportSize(viewport);
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.locator(ROOT_SELECTOR[route]).first().waitFor({ state: 'visible', timeout: 15_000 });

  // 关掉过渡/动画，隐藏光标闪烁，让像素稳定。
  await page.addStyleTag({
    content:
      '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  const file = path.join(SHOT_DIR, `${slug(route)}-${theme}-${kind}.png`);
  await page.screenshot({ path: file, fullPage: true });
}

test.describe('Quiet Grid 双主题截图矩阵', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
  });

  for (const theme of THEMES) {
    for (const route of ROUTES) {
      test(`desktop ${slug(route)} @ ${theme}`, async ({ page }) => {
        await capture(page, theme, route, DESKTOP, 'desktop');
      });
    }
    for (const route of MOBILE_ROUTES) {
      test(`mobile ${slug(route)} @ ${theme}`, async ({ page }) => {
        await capture(page, theme, route, MOBILE, 'mobile');
      });
    }
  }
});
