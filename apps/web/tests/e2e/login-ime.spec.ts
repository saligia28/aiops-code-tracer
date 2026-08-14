import { test, expect } from '@playwright/test';

// 登录页密码框的输入法防护回归：中文/全角字符（IME 上屏产物）必须被过滤，
// 只留 ASCII，并给出提示。真实 IME 组合无法在 Playwright 里模拟，
// 这里通过逐字键入与粘贴两条路径覆盖同一个 stripNonAscii 处理器。
test.describe('登录页密码框 IME 过滤', () => {
  test('逐字键入混入中文与全角标点时只保留 ASCII 并出现提示', async ({ page }) => {
    await page.goto('/login');
    const input = page.locator('input[type="password"]');
    await expect(input).toBeVisible();

    await input.pressSequentially('abc测试12！3。', { delay: 20 });
    await expect(input).toHaveValue('abc123');
    await expect(page.locator('.ime-hint')).toBeVisible();

    // 切回英文继续输入后提示消失
    await input.pressSequentially('xy', { delay: 20 });
    await expect(input).toHaveValue('abc123xy');
    await expect(page.locator('.ime-hint')).toHaveCount(0);
  });

  test('整段填入（粘贴路径）同样过滤非 ASCII', async ({ page }) => {
    await page.goto('/login');
    const input = page.locator('input[type="password"]');
    await input.fill('p@ss你好word');
    await expect(input).toHaveValue('p@ssword');
    await expect(page.locator('.ime-hint')).toBeVisible();
  });
});
