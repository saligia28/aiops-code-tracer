/**
 * antd 的主题桥接层。
 *
 * 设计令牌只有一份事实源 —— quiet-grid.css 里的 --qg-*。这里在运行时把它们读出来喂给
 * ConfigProvider，而不是在 TS 里再抄一份色值：换肤只改 CSS，antd 自动跟随。
 * 主题切换时 useThemeMode 会触发重算（暗色再叠加 darkAlgorithm 推导中间色阶）。
 *
 * 另外把 App.useApp() 的 message/modal 实例登记到模块级出口（feedback.ts），
 * 让非组件代码（事件回调、SSE 处理）也能像迁移前的 ElMessage 那样直接调用。
 */
import { App, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useThemeMode } from '@/hooks/useThemeMode';
import { registerFeedback } from './feedback';
import { PromptHost } from './prompt';

/** 读一个 CSS 变量的当前计算值。 */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useAntdThemeConfig() {
  const mode = useThemeMode();

  return useMemo(() => {
    const fg = cssVar('--qg-fg');
    const bg = cssVar('--qg-bg');

    return {
      algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        // 主色沿用"中性化"策略：迁移前把 Element Plus 的主色也压成了前景色，
        // 页面不出现第二种强调色。
        colorPrimary: fg,
        colorSuccess: cssVar('--qg-success'),
        colorWarning: cssVar('--qg-warning'),
        colorError: cssVar('--qg-danger'),
        colorInfo: cssVar('--qg-muted'),
        colorLink: fg,
        colorTextBase: fg,
        colorBgBase: bg,
        colorBgElevated: cssVar('--qg-elevated'),
        colorBgContainer: cssVar('--qg-bg'),
        colorBorder: cssVar('--qg-line'),
        colorBorderSecondary: cssVar('--qg-line'),
        colorText: fg,
        colorTextSecondary: cssVar('--qg-muted'),
        colorTextTertiary: cssVar('--qg-muted'),
        colorTextQuaternary: cssVar('--qg-faint'),
        colorTextPlaceholder: cssVar('--qg-faint'),
        colorFillSecondary: cssVar('--qg-surface'),
        colorFillTertiary: cssVar('--qg-surface'),
        colorFillQuaternary: cssVar('--qg-surface'),
        // 状态色只体现在文字上，底色一律回到中性令牌面。
        // antd 默认给 success/warning/error 各自的浅色底，暗色主题下会变成一块 near-white
        // 的色片，和 Quiet Grid 的克制底噪冲突（迁移前对 el-tag 也是同样处理）。
        colorSuccessBg: cssVar('--qg-surface'),
        colorSuccessBorder: cssVar('--qg-line'),
        colorWarningBg: cssVar('--qg-surface'),
        colorWarningBorder: cssVar('--qg-line'),
        colorErrorBg: cssVar('--qg-surface'),
        colorErrorBorder: cssVar('--qg-line'),
        colorInfoBg: cssVar('--qg-surface'),
        colorInfoBorder: cssVar('--qg-line'),
        // Quiet Grid 是"直角"的：2px 圆角、1px 细线。
        borderRadius: 2,
        borderRadiusLG: 2,
        borderRadiusSM: 2,
        borderRadiusXS: 2,
        wireframe: false,
        fontFamily: cssVar('--qg-font-sans'),
        fontFamilyCode: cssVar('--qg-font-mono'),
      },
      components: {
        // 弹窗底色统一走"浮起面"，内边距交给 glass-dialog.css 按 28px 版心排。
        Modal: {
          contentBg: cssVar('--qg-elevated'),
          headerBg: cssVar('--qg-elevated'),
          footerBg: cssVar('--qg-elevated'),
          titleColor: fg,
        },
      },
    };
  }, [mode]);
}

/** 把 App.useApp() 的实例交给模块级出口。 */
function FeedbackBridge() {
  const { message, modal } = App.useApp();

  useEffect(() => {
    registerFeedback({ message, modal });
  }, [message, modal]);

  return null;
}

export function AntdProvider({ children }: { children: ReactNode }) {
  const themeConfig = useAntdThemeConfig();

  return (
    <ConfigProvider theme={themeConfig} locale={zhCN}>
      {/* component={false}：不要多包一层 div，app-shell 的高度契约靠的是 #app 直系子元素 */}
      <App component={false}>
        <FeedbackBridge />
        <PromptHost />
        {children}
      </App>
    </ConfigProvider>
  );
}
