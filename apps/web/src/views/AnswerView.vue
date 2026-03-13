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
              <div v-show="!turn.stepsCollapsed" class="agent-steps-body">
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
        <button class="send-btn" @click="handleAsk" :disabled="isAnyLoading || !newQuestion.trim()">
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
import axios from 'axios';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { useCurrentRepo } from '@/composables/useCurrentRepo';

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
const newQuestion = ref('');
const history = ref<ConversationTurn[]>([]);
const mode = ref<AnswerMode>('agent');

const isAnyLoading = computed(() => history.value.some(t => t.loading));

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

  try {
    const res = await axios.post('/api/ask', { question: q }, {
      timeout: ASK_TIMEOUT_MS,
    });
    turn.answer = res.data.answer || '未能生成回答';
    turn.renderedAnswer = renderMarkdown(turn.answer);
    turn.followUp = res.data.followUp || [];
  } catch {
    turn.error = '查询超时或失败，请检查模型服务后重试';
  } finally {
    clearInterval(elapsedTimer);
    turn.loading = false;
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

  try {
    const resp = await fetch('/api/agent/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });

    if (!resp.ok) {
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
  } catch {
    if (!turn.error) {
      turn.error = '连接中断或超时';
    }
  } finally {
    clearInterval(elapsedTimer);
    turn.loading = false;
    await scrollToBottom();
  }
}

async function scrollToBottom() {
  await nextTick();
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

// 监听路由参数
watch(
  () => route.query.q as string,
  (q) => {
    if (q && history.value.length === 0) {
      if (mode.value === 'agent') {
        fetchAgentAnswer(q);
      } else {
        fetchAnswer(q);
      }
    }
  },
  { immediate: true },
);

onMounted(() => {
  inputRef.value?.focus();
});
</script>

<style scoped>
.answer-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f9fafb;
}

/* 顶部导航 */
.top-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  background: #fff;
  border-bottom: 1px solid #eef0f4;
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: #f4f5f7;
  border-radius: 10px;
  color: #5a5e72;
  cursor: pointer;
  transition: all 0.2s;
}

.back-btn:hover {
  background: #eef0f4;
  color: #1a1a2e;
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #4f6ef7;
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}

/* 模式切换 */
.mode-switch {
  margin-left: auto;
  display: flex;
  background: #f4f5f7;
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.mode-btn {
  padding: 5px 12px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12px;
  color: #8b8fa3;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.mode-btn.active {
  background: #fff;
  color: #4f6ef7;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.mode-btn:hover:not(.active) {
  color: #5a5e72;
}

/* 对话区域 */
.conversation {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px;
}

.turn {
  max-width: 780px;
  margin: 0 auto 32px;
}

/* 用户问题气泡 */
.question-bubble {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 16px;
}

.bubble-content {
  background: #4f6ef7;
  color: #fff;
  padding: 10px 18px;
  border-radius: 18px 18px 4px 18px;
  font-size: 15px;
  line-height: 1.6;
  max-width: 75%;
  word-break: break-word;
}

/* AI 回答 */
.answer-section {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.ai-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: #eef1ff;
  color: #4f6ef7;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.answer-body {
  flex: 1;
  min-width: 0;
}

/* Agent 步骤 */
.agent-steps {
  margin-bottom: 12px;
  border: 1px solid #e8ebf0;
  border-radius: 12px;
  background: #fafbfd;
  overflow: hidden;
}

.agent-steps-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.agent-steps-header:hover {
  background: #f0f2f6;
}

.chevron-icon {
  transition: transform 0.2s;
  color: #8b8fa3;
}

.chevron-open {
  transform: rotate(90deg);
}

.steps-label {
  font-size: 12px;
  color: #8b8fa3;
  font-weight: 500;
}

.steps-loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4f6ef7;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.agent-steps-body {
  border-top: 1px solid #e8ebf0;
  padding: 8px 14px;
  max-height: 400px;
  overflow-y: auto;
}

.agent-step {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  align-items: flex-start;
}

.agent-step + .agent-step {
  border-top: 1px solid #f0f2f6;
}

.step-icon {
  flex-shrink: 0;
  font-size: 13px;
  line-height: 1.5;
}

.step-content {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #5a5e72;
}

.step-thinking {
  color: #6b7280;
  font-style: italic;
}

.step-tool .tool-name {
  font-weight: 600;
  color: #4f6ef7;
  margin-right: 4px;
}

.step-tool .tool-args {
  font-size: 11px;
  color: #8b8fa3;
  background: #f0f3ff;
  padding: 1px 5px;
  border-radius: 3px;
  word-break: break-all;
}

.step-result {
  color: #6b7280;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 100px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', Menlo, monospace;
  font-size: 11px;
  background: #f8f9fb;
  padding: 4px 6px;
  border-radius: 4px;
}

/* 加载动画 */
.loading-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
}

.typing-dots {
  display: flex;
  gap: 4px;
}

.typing-dots span {
  width: 6px;
  height: 6px;
  background: #b0b4c3;
  border-radius: 50%;
  animation: bounce 1.2s infinite;
}

.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-6px); }
}

.loading-text {
  color: #8b8fa3;
  font-size: 14px;
}

.loading-elapsed {
  color: #b0b4c3;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

/* 错误消息 */
.error-msg {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #e74c3c;
  font-size: 14px;
  padding: 12px 16px;
  background: #fef5f5;
  border-radius: 12px;
}

/* Markdown 内容 */
.answer-content {
  background: #fff;
  border-radius: 16px;
  padding: 20px 24px;
  border: 1px solid #eef0f4;
  font-size: 15px;
  line-height: 1.75;
  color: #2c3e50;
}

/* Markdown 排版 */
.answer-content :deep(h1),
.answer-content :deep(h2),
.answer-content :deep(h3) {
  margin-top: 20px;
  margin-bottom: 10px;
  color: #1a1a2e;
  font-weight: 600;
}

.answer-content :deep(h1) { font-size: 20px; }
.answer-content :deep(h2) { font-size: 17px; }
.answer-content :deep(h3) { font-size: 15px; }

.answer-content :deep(p) {
  margin-bottom: 12px;
}

.answer-content :deep(ul),
.answer-content :deep(ol) {
  padding-left: 20px;
  margin-bottom: 12px;
}

.answer-content :deep(li) {
  margin-bottom: 6px;
}

.answer-content :deep(strong) {
  color: #1a1a2e;
  font-weight: 600;
}

/* 内联代码 */
.answer-content :deep(code:not(.hljs)) {
  background: #f0f3ff;
  color: #4f6ef7;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;
}

/* 代码块 */
.answer-content :deep(.code-block) {
  margin: 14px 0;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #eef0f4;
  background: #fafbfc;
}

.answer-content :deep(.code-header) {
  display: flex;
  align-items: center;
  padding: 6px 14px;
  background: #f4f5f7;
  border-bottom: 1px solid #eef0f4;
}

.answer-content :deep(.code-lang) {
  font-size: 11px;
  color: #8b8fa3;
  text-transform: uppercase;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.answer-content :deep(pre) {
  margin: 0;
  padding: 14px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
}

.answer-content :deep(pre code) {
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace;
  background: none;
  padding: 0;
}

/* 分隔线 */
.answer-content :deep(hr) {
  border: none;
  border-top: 1px solid #eef0f4;
  margin: 16px 0;
}

/* 引用块 */
.answer-content :deep(blockquote) {
  border-left: 3px solid #4f6ef7;
  padding-left: 14px;
  color: #5a5e72;
  margin: 12px 0;
}

/* 表格 */
.answer-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 14px;
}

.answer-content :deep(th),
.answer-content :deep(td) {
  padding: 8px 12px;
  border: 1px solid #eef0f4;
  text-align: left;
}

.answer-content :deep(th) {
  background: #f4f5f7;
  font-weight: 600;
  color: #1a1a2e;
}

/* 追问区域 */
.followup-area {
  margin-top: 16px;
}

.followup-label {
  font-size: 12px;
  color: #8b8fa3;
  margin-bottom: 8px;
  font-weight: 500;
}

.followup-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.followup-chip {
  padding: 7px 14px;
  border-radius: 18px;
  border: 1px solid #e2e4ea;
  background: #fff;
  color: #5a5e72;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.followup-chip:hover {
  border-color: #4f6ef7;
  color: #4f6ef7;
  background: #f0f3ff;
}

/* 底部输入 */
.input-bar {
  padding: 16px 20px;
  background: #fff;
  border-top: 1px solid #eef0f4;
  flex-shrink: 0;
}

.input-box {
  max-width: 780px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  background: #f9fafb;
  border: 1px solid #e2e4ea;
  border-radius: 14px;
  padding: 4px 4px 4px 16px;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input-box:focus-within {
  border-color: #4f6ef7;
  box-shadow: 0 2px 12px rgba(79, 110, 247, 0.1);
  background: #fff;
}

.input-box input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 14px;
  color: #1a1a2e;
  background: transparent;
  line-height: 40px;
}

.input-box input::placeholder {
  color: #b0b4c3;
}

.send-btn {
  width: 40px;
  height: 40px;
  border-radius: 10px;
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

.send-btn:hover:not(:disabled) {
  background: #3d5bd9;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 系统分隔消息 */
.system-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: #e2e4ea;
}

.divider-text {
  font-size: 12px;
  color: #8b8fa3;
  white-space: nowrap;
}
</style>
