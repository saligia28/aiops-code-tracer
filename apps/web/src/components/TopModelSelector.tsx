import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { ModelSelectRowProps } from './ModelSelectRow';
import http from '@/lib/http';
import { message } from '@/components/antd/feedback';
import { prefetchWhenIdle } from '@/lib/prefetch';
import './TopModelSelector.css';

// 两个下拉吃 antd Select（连带 rc-select / virtual-list）约 138 KB，但面板默认收起 ——
// 用动态 import 把它移出首屏包，首帧画完立刻在后台取回来。
//
// 刻意不用 React.lazy + Suspense：React 19 对"回退→内容"的切换有约 300ms 的节流，
// 即便模块早已就位，面板张开时也会先空一行再补上（实测 308ms，肉眼可见）。
// 自己拿组件塞进 state 就没有回退态，展开即是最终形态。
const importModelSelectRow = () => import('./ModelSelectRow');

interface LlmOption {
  value: string;
  label: string;
}

interface LlmRuntimeConfig {
  mode: 'api' | 'intranet';
  provider: string;
  model: string;
  baseUrl: string;
  availableModes: LlmOption[];
  availableModels: LlmOption[];
  apiProvider: string;
  apiModel: string;
  apiBaseUrl: string;
  intranetModel: string;
  intranetBaseUrl: string;
  intranetEnabled: boolean;
}

const CONFIG_TIMEOUT_MS = 4000;

/** 下拉浮层的承载类：面板的"点击外部收起"靠 closest(...) 认它，别改名。 */
const LLM_POPUP_CLASS = 'llm-floating-owned-popper';

export function TopModelSelector() {
  const [config, setConfig] = useState<LlmRuntimeConfig | null>(null);
  const [mode, setMode] = useState<'api' | 'intranet'>('api');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  // 下拉行按需取回后存进 state；取回前面板用等高占位，不会塌行
  const [ModelSelectRow, setModelSelectRow] = useState<ComponentType<ModelSelectRowProps> | null>(
    null,
  );
  const floatingRef = useRef<HTMLDivElement | null>(null);

  const availableModes: LlmOption[] = config?.availableModes ?? [{ value: 'api', label: 'API / 默认' }];

  const availableModels: LlmOption[] = config?.availableModels?.length
    ? config.availableModels
    : model
      ? [{ value: model, label: model }]
      : [];

  // 输入了候选之外的名字时把它作为一条可选项置顶（等价迁移前 el-select 的 allow-create）。
  const modelOptions = (() => {
    const query = modelSearch.trim();
    if (!query || availableModels.some((o) => o.value === query)) return availableModels;
    return [{ value: query, label: query }, ...availableModels];
  })();

  const providerLabel = loading
    ? '加载中'
    : !config
      ? '未获取配置'
      : mode === 'intranet'
        ? '内网 Ollama'
        : `API / ${config.apiProvider}`;

  const baseUrlLabel = (() => {
    const url = config?.baseUrl ?? '';
    if (!url) return '未配置地址';
    return url.replace(/^https?:\/\//, '');
  })();

  const compactLabel = loading ? '加载中...' : !config ? '未连接' : model || '未选择';

  const compactStatus = errorMessage
    ? '异常'
    : loading || !config
      ? ''
      : mode === 'intranet'
        ? '内网'
        : 'API';

  const triggerStateClass = [
    !errorMessage && config && mode === 'intranet' ? 'is-intranet' : '',
    !errorMessage && config && mode === 'api' ? 'is-api' : '',
    errorMessage ? 'is-error' : '',
    loading ? 'is-loading' : '',
    expanded ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const panelModeClass = mode === 'intranet' ? 'panel-intranet' : 'panel-api';

  function applyConfig(next: LlmRuntimeConfig) {
    setConfig(next);
    setMode(next.mode);
    setModel(next.model);
  }

  async function fetchConfig() {
    setLoading(true);
    setErrorMessage('');
    try {
      const res = await http.get<LlmRuntimeConfig>('/api/llm/config', {
        timeout: CONFIG_TIMEOUT_MS,
      });
      applyConfig(res.data);
    } catch {
      setErrorMessage('模型配置加载超时，请确认 API 服务和 /api 转发已正常');
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig(next: { mode?: 'api' | 'intranet'; model?: string }) {
    setSaving(true);
    try {
      const body: Record<string, string> = { mode: next.mode ?? mode };
      if (next.model !== undefined) body.model = next.model;
      const res = await http.post<LlmRuntimeConfig>('/api/llm/config', body, {
        timeout: CONFIG_TIMEOUT_MS,
      });
      applyConfig(res.data);
      setErrorMessage('');
      // 提示里用刚落地的配置算标签，别用这一轮渲染的旧值。
      const label =
        res.data.mode === 'intranet' ? '内网 Ollama' : `API / ${res.data.apiProvider}`;
      message.success(`已切换到 ${label} / ${res.data.model}`);
    } catch {
      setErrorMessage('切换模型失败，请确认后端接口可用');
      message.error('切换模型失败');
      await fetchConfig();
    } finally {
      setSaving(false);
    }
  }

  function handleModeChange(value: string) {
    void saveConfig({ mode: value as 'api' | 'intranet' });
  }

  function handleModelChange(value: string) {
    setModelSearch('');
    void saveConfig({ model: value });
  }

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      window.dispatchEvent(new CustomEvent('floating-panel-open', { detail: 'model' }));
    }
  }

  useEffect(() => {
    function handlePanelOpen(event: Event) {
      const customEvent = event as CustomEvent<string>;
      if (customEvent.detail !== 'model') {
        setExpanded(false);
      }
    }

    function handleClickOutside(event: Event) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (floatingRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.llm-floating-owned-popper')) return;
      setExpanded(false);
    }

    window.addEventListener('floating-panel-open', handlePanelOpen as EventListener);
    document.addEventListener('pointerdown', handleClickOutside);
    void fetchConfig();
    const cancelPrefetch = prefetchWhenIdle(async () => {
      const mod = await importModelSelectRow();
      setModelSelectRow(() => mod.default);
    });

    return () => {
      window.removeEventListener('floating-panel-open', handlePanelOpen as EventListener);
      document.removeEventListener('pointerdown', handleClickOutside);
      cancelPrefetch();
    };
    // 只在挂载/卸载时接线，与迁移前的 onMounted/onUnmounted 一致。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={floatingRef} className={`llm-floating${expanded ? ' is-expanded' : ''}`}>
      <button
        className={`llm-trigger ${triggerStateClass}`.trim()}
        type="button"
        aria-controls="model-selector-panel"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className="trigger-dot" />
        <span className="mobile-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2" y="5" width="16" height="10" rx="2" />
            <line x1="6" y1="8.5" x2="6" y2="11.5" />
            <line x1="10" y1="7.5" x2="10" y2="12.5" />
            <line x1="14" y1="8.5" x2="14" y2="11.5" />
          </svg>
        </span>
        <span className="trigger-body">
          <span className="trigger-model">{compactLabel}</span>
          <span className="trigger-badge">{compactStatus}</span>
        </span>
      </button>

      {expanded && (
        <div id="model-selector-panel" className={`llm-panel ${panelModeClass}`}>
          <div className="panel-header">
            <div className="panel-title">模型切换</div>
            <button className="panel-close" type="button" onClick={() => setExpanded(false)}>
              收起
            </button>
          </div>

          {ModelSelectRow ? (
            <ModelSelectRow
              mode={mode}
              model={model}
              availableModes={availableModes}
              modelOptions={modelOptions}
              modelSearch={modelSearch}
              onModelSearch={setModelSearch}
              disabled={saving || loading || !config}
              onModeChange={handleModeChange}
              onModelChange={handleModelChange}
              popupClass={LLM_POPUP_CLASS}
            />
          ) : (
            <div className="toolbar-row toolbar-row-placeholder" />
          )}

          <div className="toolbar-meta">
            <span>{providerLabel}</span>
            <span className="meta-sep" />
            <span>{baseUrlLabel}</span>
          </div>

          {loading ? (
            <div className="toolbar-status">正在加载模型配置...</div>
          ) : errorMessage ? (
            <div className="toolbar-status error">
              <span>{errorMessage}</span>
              <button className="retry-btn" type="button" onClick={() => void fetchConfig()}>
                重试
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
