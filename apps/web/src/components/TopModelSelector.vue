<template>
  <div ref="floatingRef" class="llm-floating" :class="{ 'is-expanded': expanded }">
    <button
      class="llm-trigger"
      :class="triggerStateClass"
      type="button"
      @click="toggleExpanded"
    >
      <span class="trigger-dot" />
      <span class="mobile-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="2" y="5" width="16" height="10" rx="2"/>
          <line x1="6" y1="8.5" x2="6" y2="11.5"/>
          <line x1="10" y1="7.5" x2="10" y2="12.5"/>
          <line x1="14" y1="8.5" x2="14" y2="11.5"/>
        </svg>
      </span>
      <span class="trigger-body">
        <span class="trigger-model">{{ compactLabel }}</span>
        <span class="trigger-badge">{{ compactStatus }}</span>
      </span>
    </button>

    <div v-if="expanded" class="llm-panel" :class="panelModeClass">
      <div class="panel-header">
        <div class="panel-title">模型切换</div>
        <button class="panel-close" type="button" @click="expanded = false">收起</button>
      </div>

      <div class="toolbar-row">
        <el-select
          v-model="mode"
          size="small"
          class="toolbar-select"
          popper-class="llm-floating-owned-popper"
          :disabled="saving || loading || !config"
          @change="handleModeChange"
        >
          <el-option
            v-for="item in availableModes"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
        <el-select
          v-model="model"
          size="small"
          class="toolbar-select toolbar-model"
          filterable
          allow-create
          default-first-option
          popper-class="llm-floating-owned-popper"
          :disabled="saving || loading || !config"
          @change="handleModelChange"
        >
          <el-option
            v-for="item in availableModels"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </div>

      <div class="toolbar-meta">
        <span>{{ providerLabel }}</span>
        <span class="meta-sep" />
        <span>{{ baseUrlLabel }}</span>
      </div>

      <div v-if="loading" class="toolbar-status">正在加载模型配置...</div>
      <div v-else-if="errorMessage" class="toolbar-status error">
        <span>{{ errorMessage }}</span>
        <button class="retry-btn" type="button" @click="fetchConfig">重试</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import http from '@/lib/http';
import { ElMessage } from 'element-plus';

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

const config = ref<LlmRuntimeConfig | null>(null);
const mode = ref<'api' | 'intranet'>('api');
const model = ref('');
const saving = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const expanded = ref(false);
const floatingRef = ref<HTMLElement | null>(null);
const CONFIG_TIMEOUT_MS = 4000;

const availableModes = computed<LlmOption[]>(() => {
  return config.value?.availableModes ?? [{ value: 'api', label: 'API / 默认' }];
});

const availableModels = computed<LlmOption[]>(() => {
  if (config.value?.availableModels?.length) return config.value.availableModels;
  return model.value ? [{ value: model.value, label: model.value }] : [];
});

const providerLabel = computed(() => {
  if (loading.value) return '加载中';
  if (!config.value) return '未获取配置';
  return mode.value === 'intranet' ? '内网 Ollama' : `API / ${config.value.apiProvider}`;
});

const baseUrlLabel = computed(() => {
  const url = config.value?.baseUrl ?? '';
  if (!url) return '未配置地址';
  return url.replace(/^https?:\/\//, '');
});

const compactLabel = computed(() => {
  if (loading.value) return '加载中...';
  if (!config.value) return '未连接';
  return model.value || '未选择';
});

const compactStatus = computed(() => {
  if (errorMessage.value) return '异常';
  if (loading.value) return '';
  if (!config.value) return '';
  return mode.value === 'intranet' ? '内网' : 'API';
});

const triggerStateClass = computed(() => ({
  'is-intranet': !errorMessage.value && config.value && mode.value === 'intranet',
  'is-api': !errorMessage.value && config.value && mode.value === 'api',
  'is-error': Boolean(errorMessage.value),
  'is-loading': loading.value,
  'is-active': expanded.value,
}));

const panelModeClass = computed(() => ({
  'panel-intranet': mode.value === 'intranet',
  'panel-api': mode.value === 'api',
}));

function applyConfig(next: LlmRuntimeConfig) {
  config.value = next;
  mode.value = next.mode;
  model.value = next.model;
}

async function fetchConfig() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const res = await http.get<LlmRuntimeConfig>('/api/llm/config', {
      timeout: CONFIG_TIMEOUT_MS,
    });
    applyConfig(res.data);
  } catch {
    errorMessage.value = '模型配置加载超时，请确认 API 服务和 /api 转发已正常';
  } finally {
    loading.value = false;
  }
}

async function saveConfig(next: { mode?: 'api' | 'intranet'; model?: string }) {
  saving.value = true;
  try {
    const body: Record<string, string> = { mode: next.mode ?? mode.value };
    if (next.model !== undefined) body.model = next.model;
    const res = await http.post<LlmRuntimeConfig>('/api/llm/config', body, {
      timeout: CONFIG_TIMEOUT_MS,
    });
    applyConfig(res.data);
    errorMessage.value = '';
    ElMessage.success(`已切换到 ${providerLabel.value} / ${res.data.model}`);
  } catch {
    errorMessage.value = '切换模型失败，请确认后端接口可用';
    ElMessage.error('切换模型失败');
    await fetchConfig();
  } finally {
    saving.value = false;
  }
}

function handleModeChange(value: 'api' | 'intranet') {
  void saveConfig({ mode: value });
}

function handleModelChange(value: string) {
  void saveConfig({ model: value });
}

function toggleExpanded() {
  const next = !expanded.value;
  expanded.value = next;
  if (next) {
    window.dispatchEvent(new CustomEvent('floating-panel-open', { detail: 'model' }));
  }
}

function handlePanelOpen(event: Event) {
  const customEvent = event as CustomEvent<string>;
  if (customEvent.detail !== 'model') {
    expanded.value = false;
  }
}

function handleClickOutside(event: Event) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (floatingRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.llm-floating-owned-popper')) return;
  expanded.value = false;
}

onMounted(() => {
  window.addEventListener('floating-panel-open', handlePanelOpen as EventListener);
  document.addEventListener('pointerdown', handleClickOutside);
  void fetchConfig();
});

onUnmounted(() => {
  window.removeEventListener('floating-panel-open', handlePanelOpen as EventListener);
  document.removeEventListener('pointerdown', handleClickOutside);
});
</script>

<style scoped>
/* ---- 呼吸动画 ---- */
@keyframes breathe-api {
  0%, 100% { border-color: rgba(230, 162, 60, 0.35); box-shadow: 0 0 0 0 rgba(230, 162, 60, 0); }
  50%      { border-color: rgba(230, 162, 60, 0.8);  box-shadow: 0 0 8px 2px rgba(230, 162, 60, 0.18); }
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

/* ---- 浮窗容器 ---- */
.llm-floating {
  position: fixed;
  bottom: 80px;
  right: 16px;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
}

.llm-floating.is-expanded {
  z-index: 1210;
}

/* ---- 触发按钮 ---- */
.llm-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 140px;
  max-width: 240px;
  padding: 8px 14px;
  border: 1.5px solid rgba(224, 228, 238, 0.9);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(12px);
  transition: border-color 0.3s, box-shadow 0.3s;
}

/* 内网模式：主题色边框 */
.llm-trigger.is-intranet {
  border-color: rgba(79, 110, 247, 0.6);
}

/* API 模式：警告色 + 呼吸效果 */
.llm-trigger.is-api {
  animation: breathe-api 2.8s ease-in-out infinite;
}

/* 展开态 */
.llm-trigger.is-active {
  box-shadow: 0 4px 20px rgba(15, 23, 42, 0.10);
}

.llm-trigger.is-active.is-intranet {
  border-color: rgba(79, 110, 247, 0.75);
}

/* 错误态 */
.llm-trigger.is-error {
  border-color: rgba(208, 48, 80, 0.55);
  animation: none;
}

/* ---- 状态圆点 ---- */
.trigger-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c0c4cc;
}

.is-intranet .trigger-dot {
  background: #4f6ef7;
}

.is-api .trigger-dot {
  background: #e6a23c;
  animation: dot-pulse 2.8s ease-in-out infinite;
}

.is-error .trigger-dot {
  background: #d03050;
}

.is-loading .trigger-dot {
  background: #909399;
  animation: dot-pulse 1s ease-in-out infinite;
}

/* ---- 移动端图标（桌面隐藏）---- */
.mobile-icon {
  display: none;
  align-items: center;
  justify-content: center;
  color: #5a5e72;
}

/* ---- 按钮文字 ---- */
.trigger-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.trigger-model {
  font-size: 12.5px;
  font-weight: 600;
  color: #2b2f3a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2.5px 6px;
  border-radius: 4px;
  background: #f0f1f5;
  color: #7a8197;
}

.is-intranet .trigger-badge {
  background: rgba(79, 110, 247, 0.1);
  color: #4f6ef7;
}

.is-api .trigger-badge {
  background: rgba(230, 162, 60, 0.12);
  color: #c88a2c;
}

.is-error .trigger-badge {
  background: rgba(208, 48, 80, 0.1);
  color: #d03050;
}

/* ---- 展开面板 ---- */
.llm-panel {
  width: 340px;
  padding: 14px;
  border: 1.5px solid rgba(224, 228, 238, 0.95);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 12px 36px rgba(15, 23, 42, 0.10);
  backdrop-filter: blur(12px);
}

.llm-panel.panel-intranet {
  border-color: rgba(79, 110, 247, 0.3);
}

.llm-panel.panel-api {
  border-color: rgba(230, 162, 60, 0.3);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-title {
  font-size: 13px;
  font-weight: 700;
  color: #2b2f3a;
}

.panel-close {
  border: none;
  background: transparent;
  color: #7a8197;
  cursor: pointer;
  font-size: 12px;
  transition: color 0.2s;
}

.panel-close:hover {
  color: #4f6ef7;
}

.toolbar-row {
  display: flex;
  gap: 8px;
}

.toolbar-select {
  width: 120px;
}

.toolbar-model {
  flex: 1;
}

.toolbar-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 11.5px;
  color: #909399;
  line-height: 1.4;
}

.meta-sep {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #c0c4cc;
  flex-shrink: 0;
}

.toolbar-status {
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}

.toolbar-status.error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: #d03050;
}

.retry-btn {
  border: none;
  background: transparent;
  color: #4f6ef7;
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
}

.retry-btn:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .llm-floating {
    bottom: calc(88px + env(safe-area-inset-bottom, 0px));
    right: 16px;
    left: auto;
    align-items: flex-end;
  }

  /* 触发按钮变圆形 */
  .llm-trigger {
    width: 44px;
    height: 44px;
    min-width: 44px;
    max-width: 44px;
    border-radius: 50%;
    padding: 0;
    justify-content: center;
    position: relative;
  }

  /* 文字标签隐藏，图标显示 */
  .trigger-body {
    display: none;
  }

  .mobile-icon {
    display: flex;
  }

  /* 移动端隐藏状态圆点，状态由边框呼吸效果体现 */
  .trigger-dot {
    display: none;
  }

  /* 面板从右侧弹出，宽度自适应 */
  .llm-panel {
    width: min(340px, calc(100vw - 32px));
    max-width: none;
    margin-bottom: 8px;
  }
}
</style>
