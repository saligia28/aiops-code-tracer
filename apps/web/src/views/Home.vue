<template>
  <div class="home">
    <div class="home-header" :class="{ compact: hasHistory }">
      <div class="logo-area">
        <div class="logo-icon">
          <ProjectIcon :size="40" />
        </div>
        <h1>逻瞳</h1>
      </div>
      <p class="subtitle" v-if="!hasHistory">用自然语言提问，AI 阅读源码后直接回答</p>
    </div>

    <div class="search-area" :class="{ 'search-top': hasHistory }">
      <div class="search-box">
        <input
          ref="inputRef"
          v-model="question"
          :placeholder="placeholder"
          @keyup.enter="handleAsk"
          :disabled="loading || noProjects"
        />
        <button class="ask-btn" @click="handleAsk" :disabled="loading || noProjects || !question.trim()">
          <span v-if="loading" class="spinner" />
          <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
      <div class="no-project-hint" v-if="noProjects">
        暂无项目，请先<button class="hint-link" @click="openProjectPanel">新建并构建项目</button>后再提问
      </div>
      <div class="suggestions" v-if="!hasHistory && !noProjects">
        <button
          v-for="s in suggestions"
          :key="s"
          class="suggestion-chip"
          @click="question = s; handleAsk()"
        >{{ s }}</button>
      </div>
      <div class="tool-links" v-if="!hasHistory && !noProjects">
        <button class="tool-link" @click="router.push({ name: 'ProposePatch' })">✎ 生成修改提案</button>
      </div>
    </div>

    <div class="stats-bar" v-if="!hasHistory && indexStatus">
      <span class="stat-pill repo-pill" v-if="currentRepo">
        <strong>{{ currentRepo }}</strong>
      </span>
      <span class="stat-pill" v-if="indexStatus.totalFiles">
        <strong>{{ indexStatus.totalFiles }}</strong> 文件
      </span>
      <span class="stat-pill" v-if="indexStatus.totalNodes">
        <strong>{{ indexStatus.totalNodes }}</strong> 符号
      </span>
      <span class="stat-pill" v-if="indexStatus.totalEdges">
        <strong>{{ indexStatus.totalEdges }}</strong> 关系
      </span>
      <span class="stat-pill status" :class="indexStatus.status">
        {{ indexStatus.status === 'ready' ? '索引就绪' : indexStatus.status === 'building' ? '构建中...' : '未就绪' }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import http from '@/lib/http';
import ProjectIcon from '@/components/ProjectIcon.vue';
import { useCurrentRepo } from '@/composables/useCurrentRepo';
import { useProject } from '@/composables/useProject';
import { setPendingQuestion } from '@/composables/usePendingQuestion';

const { currentRepo } = useCurrentRepo();
const { projects, initialized: projectsInitialized } = useProject();

const router = useRouter();
const inputRef = ref<HTMLInputElement>();
const question = ref('');
const loading = ref(false);
const recentQuestions = ref<string[]>([]);
const indexStatus = ref<{
  totalFiles?: number;
  totalNodes?: number;
  totalEdges?: number;
  status: string;
} | null>(null);

const hasHistory = computed(() => recentQuestions.value.length > 0);

// 项目列表已加载且为空 → 禁用提问并引导先建项目；未加载完前不判定，避免闪现提示
const noProjects = computed(() => projectsInitialized.value && projects.value.length === 0);

const placeholder = computed(() => {
  if (noProjects.value) return '暂无项目，构建后才能提问';
  return hasHistory.value ? '继续提问...' : '描述你想了解的代码逻辑';
});

function openProjectPanel() {
  window.dispatchEvent(new CustomEvent('open-project-panel'));
}

const suggestions = [
  '订单列表的分页是怎么实现的？',
  '工艺审核保存调的是哪个接口？',
  '样衣作废按钮点击后做了什么？',
];

async function fetchIndexStatus() {
  try {
    const res = await http.get('/api/index/status');
    indexStatus.value = res.data;
  } catch {
    indexStatus.value = null;
  }
}

function handleAsk() {
  const q = question.value.trim();
  if (!q || loading.value || noProjects.value) return;
  recentQuestions.value.unshift(q);
  question.value = '';
  setPendingQuestion(q);
  router.push({ name: 'Answer' });
}

// 切换仓库后自动刷新 stats
watch(currentRepo, () => {
  fetchIndexStatus();
});

onMounted(() => {
  fetchIndexStatus();
  inputRef.value?.focus();
});
</script>

<style scoped>
.home {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--qg-space-8) var(--qg-space-6);
  transition: all 0.3s ease;
}

.home-header {
  text-align: center;
  margin-bottom: 48px;
  transition: all 0.3s ease;
}

.home-header.compact {
  margin-bottom: 20px;
}

.logo-area {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--qg-space-3);
  margin-bottom: var(--qg-space-3);
}

.logo-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-area h1 {
  font-family: var(--qg-font-display);
  font-size: 36px;
  font-weight: 500;
  color: var(--qg-fg);
  letter-spacing: -0.5px;
}

.subtitle {
  color: var(--qg-muted);
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 0.2px;
}

.search-area {
  width: 100%;
  max-width: 680px;
  transition: all 0.3s ease;
}

.search-box {
  display: flex;
  align-items: center;
  background: var(--qg-elevated);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 4px 4px 4px 20px;
  transition: border-color var(--qg-duration) ease;
}

.search-box:focus-within {
  border-color: var(--qg-line-strong);
}

.search-box input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 15px;
  color: var(--qg-fg);
  background: transparent;
  line-height: 44px;
}

.search-box input::placeholder {
  color: var(--qg-faint);
}

.ask-btn {
  width: 44px;
  height: 44px;
  border-radius: 2px;
  border: 1px solid var(--qg-fg);
  background: var(--qg-fg);
  color: var(--qg-bg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity var(--qg-duration) ease, background-color var(--qg-duration) ease;
}

.ask-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.ask-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid color-mix(in srgb, var(--qg-bg) 35%, transparent);
  border-top-color: var(--qg-bg);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.no-project-hint {
  margin-top: var(--qg-space-4);
  text-align: center;
  color: var(--qg-muted);
  font-size: 13px;
}

.hint-link {
  background: none;
  border: none;
  padding: 0 2px;
  color: var(--qg-fg);
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.hint-link:hover {
  opacity: 0.75;
}

.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--qg-space-2);
  margin-top: var(--qg-space-4);
  justify-content: center;
}

.suggestion-chip {
  padding: 8px 16px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: transparent;
  color: var(--qg-muted);
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--qg-duration) ease, color var(--qg-duration) ease, background-color var(--qg-duration) ease;
  white-space: nowrap;
}

.suggestion-chip:hover {
  border-color: var(--qg-line-strong);
  color: var(--qg-fg);
  background: var(--qg-surface);
}

.tool-links {
  display: flex;
  justify-content: center;
  margin-top: 18px;
}

.tool-link {
  background: none;
  border: none;
  color: var(--qg-muted);
  font-size: 13px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 2px;
  transition: color var(--qg-duration) ease, background-color var(--qg-duration) ease;
}

.tool-link:hover {
  color: var(--qg-fg);
  background: var(--qg-surface);
}

.stats-bar {
  display: flex;
  gap: var(--qg-space-3);
  margin-top: 40px;
  flex-wrap: wrap;
  justify-content: center;
}

.stat-pill {
  padding: 6px 14px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-surface);
  color: var(--qg-muted);
  font-family: var(--qg-font-mono);
  font-size: 13px;
}

.stat-pill strong {
  color: var(--qg-fg);
  font-weight: 600;
}

.stat-pill.status.ready {
  color: var(--qg-success);
}

.stat-pill.status.building {
  color: var(--qg-warning);
}

.stat-pill.repo-pill {
  border-color: var(--qg-line-strong);
}
</style>
