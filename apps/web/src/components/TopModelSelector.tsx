import { useEffect, useRef, useState } from 'react';
import http from '@/lib/http';
import { ElMessage, ElSelect } from '@/components/el';
import './TopModelSelector.css';

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

export function TopModelSelector() {
  const [config, setConfig] = useState<LlmRuntimeConfig | null>(null);
  const [mode, setMode] = useState<'api' | 'intranet'>('api');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [expanded, setExpanded] = useState(false);
  const floatingRef = useRef<HTMLDivElement | null>(null);

  const availableModes: LlmOption[] = config?.availableModes ?? [{ value: 'api', label: 'API / 默认' }];

  const availableModels: LlmOption[] = config?.availableModels?.length
    ? config.availableModels
    : model
      ? [{ value: model, label: model }]
      : [];

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
      ElMessage.success(`已切换到 ${label} / ${res.data.model}`);
    } catch {
      setErrorMessage('切换模型失败，请确认后端接口可用');
      ElMessage.error('切换模型失败');
      await fetchConfig();
    } finally {
      setSaving(false);
    }
  }

  function handleModeChange(value: string) {
    void saveConfig({ mode: value as 'api' | 'intranet' });
  }

  function handleModelChange(value: string) {
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

    return () => {
      window.removeEventListener('floating-panel-open', handlePanelOpen as EventListener);
      document.removeEventListener('pointerdown', handleClickOutside);
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

          <div className="toolbar-row">
            <ElSelect
              modelValue={mode}
              options={availableModes}
              size="small"
              className="toolbar-select"
              popperClass="llm-floating-owned-popper"
              disabled={saving || loading || !config}
              onChange={handleModeChange}
            />
            <ElSelect
              modelValue={model}
              options={availableModels}
              size="small"
              className="toolbar-select toolbar-model"
              filterable
              allowCreate
              defaultFirstOption
              popperClass="llm-floating-owned-popper"
              disabled={saving || loading || !config}
              onChange={handleModelChange}
            />
          </div>

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
