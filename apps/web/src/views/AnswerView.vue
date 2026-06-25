<template>
  <div class="answer-page">
    <!-- 顶部导航 -->
    <header class="top-bar">
      <button class="back-btn" @click="$router.push('/')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="brand" @click="$router.push('/')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12l2.5 2.5L16 9" />
        </svg>
        <span>逻瞳</span>
      </div>
      <!-- 模式切换 -->
      <div class="mode-switch">
        <button
          class="mode-btn"
          :class="{ active: mode === 'rag' }"
          @click="mode = 'rag'"
        >普通模式</button>
        <button
          class="mode-btn"
          :class="{ active: mode === 'agent' }"
          @click="mode = 'agent'"
        >Agent 模式</button>
      </div>
    </header>

    <!-- 对话区域 -->
    <main class="conversation" ref="conversationRef">
      <div v-for="(turn, idx) in history" :key="idx" class="turn">
        <!-- 系统分隔消息 -->
        <div v-if="turn.isSystemDivider" class="system-divider">
          <span class="divider-line" />
          <span class="divider-text">{{ turn.systemText }}</span>
          <span class="divider-line" />
        </div>

        <!-- 正常对话 -->
        <template v-else>
        <div class="question-bubble">
          <div class="bubble-content">{{ turn.question }}</div>
        </div>

        <!-- AI 回答 -->
        <div class="answer-section">
          <div class="ai-avatar">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12l2.5 2.5L16 9" />
            </svg>
          </div>
          <div class="answer-body">
            <!-- Agent 思考步骤 -->
            <div v-if="turn.steps && turn.steps.length > 0" class="agent-steps">
              <div
                class="agent-steps-header"
                @click="turn.stepsCollapsed = !turn.stepsCollapsed"
              >
                <svg
                  viewBox="0 0 24 24" width="14" height="14"
                  fill="none" stroke="currentColor" stroke-width="2"
                  :class="{ 'chevron-open': !turn.stepsCollapsed }"
                  class="chevron-icon"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
                <span class="steps-label">思考过程（{{ turn.steps.length }} 步）</span>
                <span v-if="turn.loading" class="steps-loading-dot"></span>
              </div>
              <div v-show="!turn.stepsCollapsed" class="agent-steps-body" :ref="(el) => { if (el) stepsBodyRefs[idx] = el as HTMLElement }">
                <div v-for="(step, si) in turn.steps" :key="si" class="agent-step">
                  <template v-if="step.type === 'thinking'">
                    <div class="step-icon step-thinking-icon">💭</div>
                    <div class="step-content step-thinking">{{ step.thought }}</div>
                  </template>
                  <template v-else-if="step.type === 'tool_call'">
                    <div class="step-icon step-tool-icon">🔧</div>
                    <div class="step-content step-tool">
                      <span class="tool-name">{{ step.toolName }}</span>
                      <code class="tool-args">{{ formatArgs(step.toolArgs) }}</code>
                    </div>
                  </template>
                  <template v-else-if="step.type === 'tool_result'">
                    <div class="step-icon step-result-icon">📋</div>
                    <div class="step-content step-result">{{ step.toolResult }}</div>
                  </template>
                </div>
              </div>
            </div>

            <!-- 加载状态 -->
            <div v-if="turn.loading" class="loading-indicator">
              <div class="typing-dots">
                <span></span><span></span><span></span>
              </div>
              <span class="loading-text">
                {{ turn.steps && turn.steps.length > 0 ? 'Agent 正在分析代码...' : '正在阅读代码并分析...' }}
              </span>
              <span v-if="turn.elapsed > 0" class="loading-elapsed">{{ turn.elapsed }}s</span>
            </div>

            <!-- 中止状态 -->
            <div v-else-if="turn.aborted" class="aborted-msg">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              <span>已中止</span>
            </div>

            <!-- 错误状态 -->
            <div v-else-if="turn.error" class="error-msg">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              {{ turn.error }}
            </div>

            <!-- 正常回答（Markdown 渲染） -->
            <div v-else class="answer-content markdown-body" v-html="turn.renderedAnswer"></div>

            <!-- 耗时标签 -->
            <div v-if="!turn.loading && !turn.error && !turn.aborted && turn.elapsed > 0" class="answer-duration">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>耗时 {{ turn.elapsed }}s</span>
            </div>

            <!-- 追问建议 -->
            <div v-if="turn.followUp?.length && !turn.loading" class="followup-area">
              <div class="followup-label">相关问题</div>
              <div class="followup-chips">
                <button
                  v-for="f in turn.followUp"
                  :key="f"
                  class="followup-chip"
                  @click="askFollowUp(f)"
                >{{ f }}</button>
              </div>
            </div>
          </div>
        </div>
        </template>
      </div>
    </main>

    <!-- 底部输入 -->
    <footer class="input-bar">
      <div class="input-box">
        <input
          ref="inputRef"
          v-model="newQuestion"
          placeholder="继续提问..."
          @keyup.enter="handleAsk"
          :disabled="isAnyLoading"
        />
        <button v-if="isAnyLoading" class="stop-btn" @click="handleAbort" title="中止">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <rect x="5" y="5" width="14" height="14" rx="2" />
          </svg>
        </button>
        <button v-else class="send-btn" @click="handleAsk" :disabled="!newQuestion.trim()">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '@/lib/http';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { useCurrentRepo } from '@/composables/useCurrentRepo';
import { consumePendingQuestion } from '@/composables/usePendingQuestion';

const ASK_TIMEOUT_MS = 150000; // 150 秒

const { currentRepo } = useCurrentRepo();

type AnswerMode = 'rag' | 'agent';

interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result';
  thought?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
}

interface ConversationTurn {
  question: string;
  answer: string;
  renderedAnswer: string;
  followUp: string[];
  loading: boolean;
  error: string;
  elapsed: number;
  aborted?: boolean;
  // Agent 模式
  steps?: AgentStep[];
  stepsCollapsed?: boolean;
  // 系统分隔消息
  isSystemDivider?: boolean;
  systemText?: string;
}

const route = useRoute();
const router = useRouter();
const inputRef = ref<HTMLInputElement>();
const conversationRef = ref<HTMLElement>();
const stepsBodyRefs = ref<Record<number, HTMLElement>>({});
const newQuestion = ref('');
const history = ref<ConversationTurn[]>([]);
const mode = ref<AnswerMode>('agent');

const isAnyLoading = computed(() => history.value.some(t => t.loading));
const currentAbortController = ref<AbortController | null>(null);

function handleAbort() {
  currentAbortController.value?.abort();
  currentAbortController.value = null;
}

// 配置 marked + highlight.js
const marked = new Marked({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const highlighted = hljs.highlight(text, { language }).value;
      return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`;
    },
  },
});

function renderMarkdown(text: string): string {
  if (!text) return '';
  return marked.parse(text) as string;
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

// ---- RAG 模式 ----
async function fetchAnswer(q: string) {
  if (!q) return;

  const turn = reactive<ConversationTurn>({
    question: q,
    answer: '',
    renderedAnswer: '',
    followUp: [],
    loading: true,
    error: '',
    elapsed: 0,
  });
  history.value.push(turn);
  await scrollToBottom();

  const elapsedTimer = setInterval(() => { turn.elapsed++; }, 1000);
  const ctrl = new AbortController();
  currentAbortController.value = ctrl;

  try {
    const res = await http.post('/api/ask', { question: q }, {
      timeout: ASK_TIMEOUT_MS,
      signal: ctrl.signal,
    });
    turn.answer = res.data.answer || '未能生成回答';
    turn.renderedAnswer = renderMarkdown(turn.answer);
    turn.followUp = res.data.followUp || [];
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'CanceledError' || ctrl.signal.aborted) {
      turn.aborted = true;
    } else {
      turn.error = '查询超时或失败，请检查模型服务后重试';
    }
  } finally {
    clearInterval(elapsedTimer);
    turn.loading = false;
    currentAbortController.value = null;
    await scrollToBottom();
  }
}

// ---- Agent 模式（SSE） ----
async function fetchAgentAnswer(q: string) {
  if (!q) return;

  const turn = reactive<ConversationTurn>({
    question: q,
    answer: '',
    renderedAnswer: '',
    followUp: [],
    loading: true,
    error: '',
    elapsed: 0,
    steps: [],
    stepsCollapsed: false,
  });
  history.value.push(turn);
  await scrollToBottom();

  const elapsedTimer = setInterval(() => { turn.elapsed++; }, 1000);
  const ctrl = new AbortController();
  currentAbortController.value = ctrl;

  try {
    const resp = await fetch('/api/agent/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
      credentials: 'include',
      signal: ctrl.signal,
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        router.push('/login');
        return;
      }
      turn.error = `请求失败: ${resp.status}`;
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      turn.error = '无法建立流式连接';
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            data: Record<string, unknown>;
          };

          switch (event.type) {
            case 'thinking':
              turn.steps!.push({
                type: 'thinking',
                thought: event.data.thought as string,
              });
              break;

            case 'tool_call':
              turn.steps!.push({
                type: 'tool_call',
                toolName: event.data.toolName as string,
                toolArgs: event.data.toolArgs as Record<string, unknown>,
              });
              break;

            case 'tool_result':
              turn.steps!.push({
                type: 'tool_result',
                toolResult: event.data.toolResult as string,
              });
              break;

            case 'answer_delta':
              turn.answer += event.data.delta as string;
              turn.renderedAnswer = renderMarkdown(turn.answer);
              break;

            case 'done':
              turn.answer = (event.data.answer as string) || turn.answer;
              turn.renderedAnswer = renderMarkdown(turn.answer);
              turn.followUp = (event.data.followUp as string[]) || [];
              turn.stepsCollapsed = true;
              break;

            case 'error':
              turn.error = (event.data.error as string) || '未知错误';
              break;
          }

          await scrollToBottom();
        } catch {
          // 忽略 JSON 解析错误
        }
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted) {
      turn.aborted = true;
    } else if (!turn.error) {
      turn.error = '连接中断或超时';
    }
  } finally {
    clearInterval(elapsedTimer);
    turn.loading = false;
    currentAbortController.value = null;
    await scrollToBottom();
  }
}

async function scrollToBottom() {
  await nextTick();
  // 滚动正在加载的 turn 的思考步骤区域到底部
  for (const [idx, el] of Object.entries(stepsBodyRefs.value)) {
    const turn = history.value[Number(idx)];
    if (turn?.loading && el) {
      el.scrollTop = el.scrollHeight;
    }
  }
  if (conversationRef.value) {
    conversationRef.value.scrollTop = conversationRef.value.scrollHeight;
  }
}

function handleAsk() {
  const q = newQuestion.value.trim();
  if (!q || isAnyLoading.value) return;
  newQuestion.value = '';

  if (mode.value === 'agent') {
    fetchAgentAnswer(q);
  } else {
    fetchAnswer(q);
  }
}

function askFollowUp(q: string) {
  if (isAnyLoading.value) return;
  if (mode.value === 'agent') {
    fetchAgentAnswer(q);
  } else {
    fetchAnswer(q);
  }
}

// 切换仓库后插入系统分隔消息
watch(currentRepo, (newRepo, oldRepo) => {
  if (oldRepo && newRepo && newRepo !== oldRepo && history.value.length > 0) {
    history.value.push(reactive({
      question: '', answer: '', renderedAnswer: '', followUp: [],
      loading: false, error: '', elapsed: 0,
      isSystemDivider: true,
      systemText: `已切换到仓库：${newRepo}`,
    }));
    scrollToBottom();
  }
});

onMounted(() => {
  const query = { ...route.query };
  if ('q' in query) {
    delete query.q;
    void router.replace({ name: 'Answer', query, hash: route.hash });
  }

  const pendingQuestion = consumePendingQuestion();
  if (pendingQuestion) {
    if (mode.value === 'agent') {
      void fetchAgentAnswer(pendingQuestion);
    } else {
      void fetchAnswer(pendingQuestion);
    }
  }

  inputRef.value?.focus();
});
</script>

<!-- scoped 样式外置到 ./AnswerView.styles.css（保留 scoped 语义，含 :deep() 穿透 v-html 渲染的 markdown） -->
<style scoped src="./AnswerView.styles.css"></style>
