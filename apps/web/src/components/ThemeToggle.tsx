import { useState } from 'react';
import { nextTheme, applyTheme, type Theme } from '@/lib/theme';
import './ThemeToggle.css';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [current, setCurrent] = useState<Theme>(
    (document.documentElement.dataset.theme as Theme) || 'light',
  );

  function toggle() {
    const t = nextTheme(current);
    applyTheme(t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      /* localStorage 不可用时静默降级 */
    }
    setCurrent(t);
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
