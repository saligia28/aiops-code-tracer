import { defineConfig, devices } from '@playwright/test';

// Quiet Grid 布局/主题浏览器回归。webServer 直接调 vite 二进制并用 --port 覆盖
// vite.config 从根 .env 读到的 WEB_PORT（否则会撞开发栈占用的 4200/4201）；
// 走 `pnpm dev --` 会把字面量 `--` 透传给 vite 导致端口标志失效，故这里用 `pnpm exec vite`。
export default defineConfig({
  testDir: './tests/e2e',
  // trace/截图产物单独放 artifacts 子目录，避免与 HTML 报告目录互相清空。
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: 'test-results/quiet-grid-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
