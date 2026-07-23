import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Quiet Grid 布局 + 双主题浏览器回归。
 *
 * 只用 mock 提供「布局稳定」的数据（长项目名/长模型名/就绪索引），
 * 不伪造任何业务成功流（问答/构建/提案都不 mock 成功）。断言全部基于
 * 真实 getBoundingClientRect 的矩形相交与 documentElement.scrollWidth，
 * 不做无意义的宽松阈值。
 */

// ---------- 布局压力用的稳定 mock 数据 ----------
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

// ---------- mock 安装（API + WebSocket） ----------
async function installMocks(page: Page): Promise<void> {
  // WebSocket：接受并挂起空连接（不回连真实服务端、不下发任何消息），
  // 让 app 的 new WebSocket('/ws/progress') 不报错、不刷控制台、不触发重连。
  await page.routeWebSocket(/\/ws\//, () => {
    /* 故意留空：不 connectToServer 即为纯客户端挂起连接 */
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
        return json([]); // 会话列表
      case '/api/memories':
        return json([]); // 记忆列表
      default:
        // 兜底：任何未显式匹配的 /api/** 返回空对象（200），避免首屏调用挂起。
        return json({});
    }
  });
}

// ---------- 几何/滚动断言 helper ----------
type Box = { x: number; y: number; width: number; height: number };

/** 两矩形是否相交（允许 eps 像素的亚像素/贴边容差）。 */
function intersects(a: Box, b: Box, eps = 1): boolean {
  return !(
    a.x + a.width <= b.x + eps ||
    b.x + b.width <= a.x + eps ||
    a.y + a.height <= b.y + eps ||
    b.y + b.height <= a.y + eps
  );
}

/** 元素存在且可见时返回其可视矩形，否则 null（用于跳过不在该路由/视口出现的元素）。 */
async function visibleBox(locator: Locator): Promise<Box | null> {
  if ((await locator.count()) === 0) return null;
  const first = locator.first();
  if (!(await first.isVisible())) return null;
  return await first.boundingBox();
}

/** 两个元素的可见矩形不相交（任一不可见则跳过，不误报）。 */
async function expectNoOverlap(a: Locator, b: Locator, label: string): Promise<void> {
  const ba = await visibleBox(a);
  const bb = await visibleBox(b);
  if (!ba || !bb) return;
  expect(
    intersects(ba, bb),
    `${label} 不应重叠：a=${JSON.stringify(ba)} b=${JSON.stringify(bb)}`,
  ).toBe(false);
}

/** 文档不应出现横向滚动（+1px 容差）。 */
async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `${label} 出现横向滚动：scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

/** 元素可见矩形完整落在视口内（+1px 容差；不可见则跳过）。 */
async function expectWithinViewport(page: Page, locator: Locator, label: string): Promise<void> {
  const box = await visibleBox(locator);
  if (!box) return;
  const vp = page.viewportSize()!;
  expect(box.x, `${label} 左越界`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `${label} 上越界`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} 右越界 (vw=${vp.width})`).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height, `${label} 下越界 (vh=${vp.height})`).toBeLessThanOrEqual(vp.height + 1);
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

/** 导航到路由 → 等根元素可见 → 关掉过渡/动画让 rect 稳定 → settle 一帧。 */
async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.locator(ROOT_SELECTOR[route]).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important;}',
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

// ---------- 常用元素 locator ----------
const globalBar = (page: Page) => page.locator('.global-context-bar');
const pageHeader = (page: Page) => page.locator('.page-header, .answer-page .top-bar');
const appContent = (page: Page) => page.locator('.app-content');

test.beforeEach(async ({ page }) => {
  await installMocks(page);
});

// ==================== Step 4：布局矩阵（外壳/页头不重叠 + 无横向滚动） ====================
const viewports = [
  { width: 1440, height: 900, label: 'desktop-1440' },
  { width: 1200, height: 900, label: 'desktop-1200' },
  { width: 769, height: 900, label: 'edge-769' },
  { width: 768, height: 900, label: 'mobile-768' },
  { width: 390, height: 844, label: 'mobile-390' },
];
const routes = ['/', '/login', '/answer', '/graph', '/index-manager', '/propose-patch'];

test.describe('布局矩阵：外壳/页头不重叠 + 无横向滚动', () => {
  for (const vp of viewports) {
    for (const route of routes) {
      test(`${route} @ ${vp.label}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await gotoRoute(page, route);

        const tag = `[${route}@${vp.label}]`;
        // 无横向滚动
        await expectNoHorizontalScroll(page, tag);
        // 全局上下文栏 vs 页级页头（移动端全局栏为 display:contents 无盒 → 自动跳过）
        await expectNoOverlap(globalBar(page), pageHeader(page), `${tag} 全局栏 vs 页头`);
        // 全局上下文栏 vs 内容区
        await expectNoOverlap(globalBar(page), appContent(page), `${tag} 全局栏 vs 内容区`);
      });
    }
  }
});

// ==================== Step 4：选择器面板展开后留在视口内 ====================
test.describe('选择器面板展开后留在视口内', () => {
  for (const vp of [
    { width: 1440, height: 900, label: 'desktop-1440' },
    { width: 768, height: 900, label: 'mobile-768' },
    { width: 390, height: 844, label: 'mobile-390' },
  ]) {
    test(`项目/模型面板 @ ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoRoute(page, '/');

      // 展开项目选择器
      await page.locator('.project-trigger').click();
      const projectPanel = page.locator('#project-selector-panel');
      await projectPanel.waitFor({ state: 'visible' });
      await expectWithinViewport(page, projectPanel, `[${vp.label}] 项目面板`);

      // 展开模型选择器（floating-panel-open 事件会收起项目面板）
      await page.locator('.llm-trigger').click();
      const modelPanel = page.locator('#model-selector-panel');
      await modelPanel.waitFor({ state: 'visible' });
      await expectWithinViewport(page, modelPanel, `[${vp.label}] 模型面板`);

      await expectNoHorizontalScroll(page, `[${vp.label}] 面板展开`);
    });
  }
});

// ==================== Step 4：移动端 FAB 不遮挡问答输入条 ====================
test.describe('移动端：选择器 FAB 不遮挡问答输入条', () => {
  for (const vp of [
    { width: 768, height: 900, label: 'mobile-768' },
    { width: 390, height: 844, label: 'mobile-390' },
  ]) {
    test(`FAB vs 输入条 @ ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoRoute(page, '/answer');

      const input = page.locator('.answer-page .input-bar');
      await input.waitFor({ state: 'visible' });
      await expectNoOverlap(page.locator('.project-floating'), input, `[${vp.label}] 项目FAB vs 输入条`);
      await expectNoOverlap(page.locator('.llm-floating'), input, `[${vp.label}] 模型FAB vs 输入条`);
    });
  }
});

// ==================== Step 4：问答侧栏（桌面并列 / 移动抽屉带遮罩） ====================
test.describe('问答侧栏：桌面并列不遮挡 / 移动抽屉带遮罩', () => {
  for (const vp of [
    { width: 1440, height: 900, label: 'desktop-1440' },
    { width: 1200, height: 900, label: 'desktop-1200' },
  ]) {
    test(`桌面侧栏与主列并列不重叠 @ ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoRoute(page, '/answer');

      const sidebar = page.locator('.session-sidebar');
      await expect(sidebar).toBeVisible(); // 桌面默认展开
      await expectNoOverlap(sidebar, page.locator('.main-col'), `[${vp.label}] 侧栏 vs 主列`);
      // 桌面不应有抽屉遮罩（元素可能在 DOM 里但 display:none）
      await expect(page.locator('.sidebar-backdrop')).toBeHidden();
    });
  }

  for (const vp of [
    { width: 768, height: 900, label: 'mobile-768' },
    { width: 390, height: 844, label: 'mobile-390' },
  ]) {
    test(`移动端侧栏为带遮罩的抽屉 @ ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoRoute(page, '/answer');

      // 移动端默认收起：无遮罩
      await expect(page.locator('.sidebar-backdrop')).toBeHidden();

      // 打开抽屉 → 出现遮罩，且抽屉栏落在视口内
      await page.locator('.sidebar-toggle').click();
      await expect(page.locator('.sidebar-backdrop')).toBeVisible();
      await expectWithinViewport(page, page.locator('.session-sidebar'), `[${vp.label}] 抽屉侧栏`);
      await expectNoHorizontalScroll(page, `[${vp.label}] 抽屉展开`);
    });
  }
});

// ==================== Step 5：主题（初始跟随系统 / 切换持久化 / 三处同步） ====================
async function readThemeState(page: Page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    colorScheme: document.documentElement.style.colorScheme,
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  }));
}

test.describe('主题：初始跟随系统 / 切换持久化 / 三处同步', () => {
  test('无存储值时 data-theme 跟随 prefers-color-scheme=dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoRoute(page, '/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const { meta } = await readThemeState(page);
    expect(meta).toBe('#111214');
  });

  test('无存储值时 data-theme 跟随 prefers-color-scheme=light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoRoute(page, '/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const { meta } = await readThemeState(page);
    expect(meta).toBe('#f7f6f2');
  });

  test('点击切换后刷新仍保持（localStorage 持久化）', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoRoute(page, '/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.locator('.login-theme-toggle').click(); // → dark
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('dark');

    // 刷新后首屏内联脚本读 localStorage，仍应为 dark（覆盖系统的 light）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('切换三处同步：data-theme / colorScheme / meta theme-color', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoRoute(page, '/login');

    await page.locator('.login-theme-toggle').click(); // → dark
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await readThemeState(page);
    expect(dark.theme).toBe('dark');
    expect(dark.colorScheme).toBe('dark');
    expect(dark.meta).toBe('#111214');

    await page.locator('.login-theme-toggle').click(); // → light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const light = await readThemeState(page);
    expect(light.theme).toBe('light');
    expect(light.colorScheme).toBe('light');
    expect(light.meta).toBe('#f7f6f2');
  });
});
