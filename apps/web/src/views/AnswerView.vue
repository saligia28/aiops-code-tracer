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
    </header>

    <!-- 对话区域 -->
    <main class="conversation" ref="conversationRef">
      <div v-for="(turn, idx) in history" :key="idx" class="turn">
        <!-- 用户问题 -->
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
            <!-- 加载状态 -->
            <div v-if="turn.loading" class="loading-indicator">
              <div class="typing-dots">
                <span></span><span></span><span></span>
              </div>
              <span class="loading-text">正在阅读代码并分析...</span>
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

const ASK_TIMEOUT_MS = 150000; // 150 秒：后端可能有多轮 LLM 调用（分析+生成），需留足时间

interface ConversationTurn {
  question: string;
  answer: string;
  renderedAnswer: string;
  followUp: string[];
  loading: boolean;
  error: string;
  elapsed: number; // 已耗时（秒）
}

const route = useRoute();
const router = useRouter();
const inputRef = ref<HTMLInputElement>();
const conversationRef = ref<HTMLElement>();
const newQuestion = ref('');
const history = ref<ConversationTurn[]>([]);

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

async function fetchAnswer(q: string) {
  if (!q) return;

  // 注意：必须是 reactive 对象，后续异步修改 turn.xxx 才能触发视图更新
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

  // 计时器：每秒更新已耗时
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
  fetchAnswer(q);
}

function askFollowUp(q: string) {
  if (isAnyLoading.value) return;
  fetchAnswer(q);
}

// 监听路由参数
watch(
  () => route.query.q as string,
  (q) => {
    if (q && history.value.length === 0) {
      fetchAnswer(q);
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
</style>
