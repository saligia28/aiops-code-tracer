import { nextTheme } from '@/lib/theme';
import { setThemeMode, useThemeMode } from '@/hooks/useThemeMode';
import './ThemeToggle.css';

export function ThemeToggle({ className = '' }: { className?: string }) {
  // 主题是全局状态：antd 的 ConfigProvider 也要跟着切换算法与令牌。
  const current = useThemeMode();

  function toggle() {
    setThemeMode(nextTheme(current));
  }

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      aria-label={current === 'dark' ? '切换到白天模式' : '切换到夜间模式'}
      onClick={toggle}
    >
      {current === 'dark' ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
