/**
 * 主题（明/暗）的共享状态。
 *
 * 迁移前主题只存在于 DOM（<html data-theme>）与 ThemeToggle 的局部 state 里；
 * 接入 antd 后 ConfigProvider 必须跟着主题切换重算 token，所以要有一份可订阅的状态。
 * 真正的落地动作仍然交给 lib/theme.ts 的 applyTheme（data-theme + colorScheme +
 * meta theme-color 三处同步），这里只负责"广播"。
 */
import { createStore, useStore } from '@/lib/store';
import { applyTheme, type Theme } from '@/lib/theme';

function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) || 'light';
}

const themeStore = createStore<Theme>(currentTheme());

export function setThemeMode(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* localStorage 不可用时静默降级 */
  }
  themeStore.set(theme);
}

export function useThemeMode(): Theme {
  return useStore(themeStore);
}
