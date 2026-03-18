<template>
  <div class="home">
    <div class="home-header" :class="{ compact: hasHistory }">
      <div class="logo-area">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12l2.5 2.5L16 9" />
          </svg>
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
          :placeholder="hasHistory ? '继续提问...' : '描述你想了解的代码逻辑'"
          @keyup.enter="handleAsk"
          :disabled="loading"
        />
        <button class="ask-btn" @click="handleAsk" :disabled="loading || !question.trim()">
          <span v-if="loading" class="spinner" />
          <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
      <div class="suggestions" v-if="!hasHistory">
        <button
          v-for="s in suggestions"
          :key="s"
          class="suggestion-chip"
          @click="question = s; handleAsk()"
        >{{ s }}</button>
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
import { useCurrentRepo } from '@/composables/useCurrentRepo';

const { currentRepo } = useCurrentRepo();

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
  if (!q || loading.value) return;
  recentQuestions.value.unshift(q);
  question.value = '';
  router.push({ name: 'Answer', query: { q } });
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
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
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
  gap: 12px;
  margin-bottom: 12px;
}

.logo-icon {
  color: #4f6ef7;
}

.logo-area h1 {
  font-size: 32px;
  font-weight: 700;
  color: #1a1a2e;
  letter-spacing: -0.5px;
}

.subtitle {
  color: #8b8fa3;
  font-size: 16px;
  font-weight: 400;
}

.search-area {
  width: 100%;
  max-width: 680px;
  transition: all 0.3s ease;
}

.search-box {
  display: flex;
  align-items: center;
  background: #fff;
  border: 1px solid #e2e4ea;
  border-radius: 16px;
  padding: 4px 4px 4px 20px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.04);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.search-box:focus-within {
  border-color: #4f6ef7;
  box-shadow: 0 2px 20px rgba(79, 110, 247, 0.12);
}

.search-box input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 15px;
  color: #1a1a2e;
  background: transparent;
  line-height: 44px;
}

.search-box input::placeholder {
  color: #b0b4c3;
}

.ask-btn {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  border: none;
  background: #4f6ef7;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.2s, opacity 0.2s;
}

.ask-btn:hover:not(:disabled) {
  background: #3d5bd9;
}

.ask-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  justify-content: center;
}

.suggestion-chip {
  padding: 8px 16px;
  border-radius: 20px;
  border: 1px solid #e2e4ea;
  background: #fff;
  color: #5a5e72;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.suggestion-chip:hover {
  border-color: #4f6ef7;
  color: #4f6ef7;
  background: #f0f3ff;
}

.stats-bar {
  display: flex;
  gap: 12px;
  margin-top: 40px;
  flex-wrap: wrap;
  justify-content: center;
}

.stat-pill {
  padding: 6px 14px;
  border-radius: 20px;
  background: #f4f5f7;
  color: #8b8fa3;
  font-size: 13px;
}

.stat-pill strong {
  color: #1a1a2e;
  font-weight: 600;
}

.stat-pill.status.ready {
  background: #e8f5e9;
  color: #2e7d32;
}

.stat-pill.status.building {
  background: #fff3e0;
  color: #ef6c00;
}

.stat-pill.repo-pill {
  background: rgba(79, 110, 247, 0.08);
  color: #4f6ef7;
}

.stat-pill.repo-pill strong {
  color: #4f6ef7;
}
</style>
