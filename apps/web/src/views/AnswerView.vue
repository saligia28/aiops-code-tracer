<template>
  <div class="answer-page">
    <!-- 顶部导航 -->
    <header class="top-bar">
      <button class="back-btn" @click="$router.push('/')">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        class="sidebar-toggle"
        :class="{ 'is-collapsed': sidebarCollapsed }"
        :title="sidebarCollapsed ? '展开会话栏' : '收起会话栏'"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
      <div class="brand" @click="$router.push('/')">
        <ProjectIcon :size="28" />
        <span>逻瞳</span>
      </div>
      <!-- 模式切换 -->
      <div class="mode-switch">
        <button class="mode-btn" :class="{ active: mode === 'rag' }" @click="mode = 'rag'">普通模式</button>
        <button class="mode-btn" :class="{ active: mode === 'agent' }" @click="mode = 'agent'">Agent 模式</button>
      </div>
    </header>

    <!-- 主体：左侧会话栏 + 右侧对话/输入列 -->
    <div class="body-shell">
      <!-- 移动端遮罩：展开时点击空白处收起 -->
      <div v-if="!sidebarCollapsed" class="sidebar-backdrop" @click="sidebarCollapsed = true" />

      <!-- 左侧会话 + 记忆侧栏 -->
      <aside class="session-sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
        <!-- 会话列表（上半部） -->
        <div class="sidebar-section conversations-section">
          <button class="new-chat-btn" @click="startNewConversation">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>新建会话</span>
          </button>

          <el-scrollbar class="conversations-scroll">
            <div v-if="conversationsLoading" class="sidebar-status">加载中...</div>
            <div v-else-if="conversations.length === 0" class="sidebar-empty">暂无会话，提问后自动创建</div>
            <ul v-else class="conversation-list">
              <li
                v-for="c in conversations"
                :key="c.id"
                class="conversation-item"
                :class="{ active: c.id === activeConversationId }"
                @click="switchConversation(c.id)"
              >
                <div class="conv-main">
                  <span class="conv-title">{{ conversationLabel(c) }}</span>
                  <span class="conv-time">{{ relativeTime(c.updatedAt) }}</span>
                </div>
                <div class="conv-actions">
                  <button class="conv-action-btn" title="重命名" @click.stop="renameConversationPrompt(c)">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                      <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <el-popconfirm
                    title="确定删除该会话？"
                    confirm-button-text="删除"
                    cancel-button-text="取消"
                    confirm-button-type="danger"
                    width="200"
                    @confirm="removeConversation(c)"
                  >
                    <template #reference>
                      <button class="conv-action-btn conv-delete" title="删除" @click.stop>
                        <svg
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </template>
                  </el-popconfirm>
                </div>
              </li>
            </ul>
          </el-scrollbar>
        </div>

        <!-- 记忆面板（下半部，可折叠） -->
        <div class="sidebar-section memory-section" :class="{ 'is-folded': memoryFolded }">
          <div class="memory-header" @click="memoryFolded = !memoryFolded">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="chevron-icon"
              :class="{ 'chevron-open': !memoryFolded }"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            <span class="memory-title">项目记忆</span>
            <span class="memory-count" v-if="memories.length > 0">{{ memories.length }}</span>
          </div>
          <el-scrollbar v-show="!memoryFolded" class="memory-scroll">
            <div v-if="memoriesLoading" class="sidebar-status">加载中...</div>
            <div v-else-if="memories.length === 0" class="sidebar-empty">暂无记忆，问答后会自动沉淀</div>
            <ul v-else class="memory-list">
              <li v-for="m in memories" :key="m.id" class="memory-item">
                <div class="memory-content">{{ m.content }}</div>
                <div class="memory-meta">
                  <span class="memory-time">{{ relativeTime(m.createdAt) }}</span>
                  <el-popconfirm
                    title="删除这条记忆？"
                    confirm-button-text="删除"
                    cancel-button-text="取消"
                    confirm-button-type="danger"
                    width="180"
                    @confirm="removeMemory(m)"
                  >
                    <template #reference>
                      <button class="memory-delete" title="删除" @click.stop>
                        <svg
                          viewBox="0 0 24 24"
                          width="13"
                          height="13"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </template>
                  </el-popconfirm>
                </div>
              </li>
            </ul>
          </el-scrollbar>
        </div>
      </aside>

      <!-- 右侧对话 + 输入列 -->
      <div class="main-col">
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
                  <ProjectIcon :size="26" />
                </div>
                <div class="answer-body">
                  <!-- Agent 执行计划（P1-C）：plan 事件一次性下发，服务端暂无逐步完成状态——
                 只如实展示计划本身，不伪造勾选进度 -->
                  <div v-if="turn.planSteps && turn.planSteps.length > 0" class="agent-plan">
                    <div class="agent-plan-header">
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                      >
                        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                        <rect x="9" y="3" width="6" height="4" rx="1" />
                        <path d="M9 12h6M9 16h6" />
                      </svg>
                      <span class="plan-label">执行计划（{{ turn.planSteps.length }} 步）</span>
                    </div>
                    <ol class="agent-plan-list">
                      <li v-for="(planStep, pi) in turn.planSteps" :key="pi">{{ planStep }}</li>
                    </ol>
                  </div>

                  <!-- Agent 思考步骤 -->
                  <div v-if="turn.steps && turn.steps.length > 0" class="agent-steps">
                    <div class="agent-steps-header" @click="turn.stepsCollapsed = !turn.stepsCollapsed">
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        :class="{ 'chevron-open': !turn.stepsCollapsed }"
                        class="chevron-icon"
                      >
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                      <span class="steps-label">思考过程（{{ turn.steps.length }} 步）</span>
                      <span v-if="turn.loading" class="steps-loading-dot"></span>
                    </div>
                    <div
                      v-show="!turn.stepsCollapsed"
                      class="agent-steps-body"
                      :ref="
                        el => {
                          if (el) stepsBodyRefs[idx] = el as HTMLElement
                        }
                      "
                    >
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
                    <div class="typing-dots"><span></span><span></span><span></span></div>
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

                  <!-- 追问建议 TODO:暂时也不要这个模块功能，后续打磨后开放-->
                  <!-- <div v-if="turn.followUp?.length && !turn.loading" class="followup-area">
                        <div class="followup-label">相关问题</div>
                        <div class="followup-chips">
                          <button
                            v-for="f in turn.followUp"
                            :key="f"
                            class="followup-chip"
                            @click="askFollowUp(f)"
                          >{{ f }}</button>
                        </div>
                      </div> -->
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
      <!-- /main-col -->
    </div>
    <!-- /body-shell -->
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github.css'
import ProjectIcon from '@/components/ProjectIcon.vue'
import { useCurrentRepo } from '@/composables/useCurrentRepo'
import { useProject } from '@/composables/useProject'
import { useConversation, relativeTime, type Conversation, type Memory } from '@/composables/useConversation'
import { consumePendingQuestion } from '@/composables/usePendingQuestion'

const { currentRepo } = useCurrentRepo()
const { currentProjectId } = useProject()
const {
  activeConversationId,
  setActiveConversation,
  clearActiveConversation,
  restoreConversation,
  loadConversation,
  listConversations,
  renameConversation,
  deleteConversation,
  listMemories,
  deleteMemory,
} = useConversation()

type AnswerMode = 'rag' | 'agent'

interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result'
  thought?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
}

interface ConversationTurn {
  question: string
  answer: string
  renderedAnswer: string
  followUp: string[]
  loading: boolean
  error: string
  elapsed: number
  aborted?: boolean
  // Agent 模式
  steps?: AgentStep[]
  stepsCollapsed?: boolean
  /** Agent 执行计划（P1-C plan 事件），一次性下发的步骤清单 */
  planSteps?: string[]
  // 系统分隔消息
  isSystemDivider?: boolean
  systemText?: string
}

const route = useRoute()
const router = useRouter()
const inputRef = ref<HTMLInputElement>()
const conversationRef = ref<HTMLElement>()
const stepsBodyRefs = ref<Record<number, HTMLElement>>({})
const newQuestion = ref('')
const history = ref<ConversationTurn[]>([])
const mode = ref<AnswerMode>('agent')

const isAnyLoading = computed(() => history.value.some(t => t.loading))
const currentAbortController = ref<AbortController | null>(null)

function handleAbort() {
  currentAbortController.value?.abort()
  currentAbortController.value = null
}

// ---- 左侧栏：会话列表 + 记忆面板 ----
const sidebarCollapsed = ref(false)
const memoryFolded = ref(false)

const conversations = ref<Conversation[]>([])
const conversationsLoading = ref(false)
const memories = ref<Memory[]>([])
const memoriesLoading = ref(false)

function conversationLabel(c: Conversation): string {
  const title = c.title?.trim()
  return title || '未命名会话'
}

async function refreshConversations() {
  conversationsLoading.value = true
  try {
    conversations.value = await listConversations()
  } catch {
    // 列表拉取失败静默：不阻断问答主流程
  } finally {
    conversationsLoading.value = false
  }
}

async function refreshMemories() {
  memoriesLoading.value = true
  try {
    memories.value = await listMemories()
  } catch {
    // 同上，静默失败
  } finally {
    memoriesLoading.value = false
  }
}

// 新建会话：复用切项目时的清空逻辑（活动会话 id 置空 + 清空 history），起一条干净新会话。
function startNewConversation() {
  if (isAnyLoading.value) handleAbort()
  clearActiveConversation()
  history.value = []
  if (window.innerWidth <= 768) sidebarCollapsed.value = true
}

// 切换会话：GET 该会话消息 → messagesToTurns 还原 → 填进 history 并设为活动会话。
async function switchConversation(id: string) {
  if (id === activeConversationId.value) {
    if (window.innerWidth <= 768) sidebarCollapsed.value = true
    return
  }
  if (isAnyLoading.value) handleAbort()
  try {
    const { turns } = await loadConversation(id, renderMarkdown)
    history.value = turns.map(t => reactive(t))
    setActiveConversation(id)
    if (window.innerWidth <= 768) sidebarCollapsed.value = true
    await scrollToBottom()
  } catch {
    ElMessage.error('加载会话失败')
  }
}

// 重命名：弹 prompt → PATCH → 局部更新列表。
async function renameConversationPrompt(c: Conversation) {
  let title: string
  try {
    const res = await ElMessageBox.prompt('请输入新的会话名称', '重命名会话', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: c.title ?? '',
      inputPlaceholder: '会话名称',
    })
    title = (res.value ?? '').trim()
  } catch {
    return // 取消
  }
  if (!title || title === c.title) return
  try {
    const updated = await renameConversation(c.id, title)
    const idx = conversations.value.findIndex(x => x.id === c.id)
    if (idx !== -1) conversations.value[idx] = updated
    else await refreshConversations()
  } catch {
    ElMessage.error('重命名失败')
  }
}

// 删除：DELETE → 若删的是当前活动会话则清空 history + 活动 id → 刷新列表。
async function removeConversation(c: Conversation) {
  try {
    await deleteConversation(c.id)
    if (c.id === activeConversationId.value) {
      clearActiveConversation()
      history.value = []
    }
    await refreshConversations()
  } catch {
    ElMessage.error('删除会话失败')
  }
}

async function removeMemory(m: Memory) {
  try {
    await deleteMemory(m.id)
    memories.value = memories.value.filter(x => x.id !== m.id)
  } catch {
    ElMessage.error('删除记忆失败')
  }
}

// 本轮提问拿到 conversationId 后刷新会话列表：新会话首次出现、或已存在会话 updated_at
// 变化导致重排/标题更新，都需要重新拉取一次以保持顺序与标题同步。
function syncConversationList(conversationId: string | null | undefined) {
  if (!conversationId) return
  void refreshConversations()
}

// 配置 marked + highlight.js
const marked = new Marked({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
    },
  },
})

function renderMarkdown(text: string): string {
  if (!text) return ''
  return marked.parse(text) as string
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
}

// ---- RAG 模式 ----
async function fetchAnswer(q: string) {
  if (!q) return

  const turn = reactive<ConversationTurn>({
    question: q,
    answer: '',
    renderedAnswer: '',
    followUp: [],
    loading: true,
    error: '',
    elapsed: 0,
  })
  history.value.push(turn)
  await scrollToBottom()

  const elapsedTimer = setInterval(() => {
    turn.elapsed++
  }, 1000)
  const ctrl = new AbortController()
  currentAbortController.value = ctrl

  try {
    // 流式（P1-D）：stream:true 走 SSE，answer_delta 逐 token 打字机渲染，
    // done 终帧带完整 AskResponse（answer/followUp/conversationId）收尾兜底。
    // 服务端对快速路径/降级路径会补一帧整体 delta，因此本解析器对所有路径通用。
    const resp = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, conversationId: activeConversationId.value, stream: true }),
      credentials: 'include',
      signal: ctrl.signal,
    })

    if (!resp.ok) {
      if (resp.status === 401) {
        router.push('/login')
        return
      }
      turn.error = `请求失败: ${resp.status}`
      return
    }

    const reader = resp.body?.getReader()
    if (!reader) {
      turn.error = '无法建立流式连接'
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue

        try {
          const event = JSON.parse(jsonStr) as { type: string; data: Record<string, unknown> }

          switch (event.type) {
            case 'answer_delta':
              turn.answer += event.data.delta as string
              turn.renderedAnswer = renderMarkdown(turn.answer)
              break

            case 'done':
              // 以终帧为准（流式拼接与整包语义一致，这里兜底覆盖）
              turn.answer = (event.data.answer as string) || turn.answer || '未能生成回答'
              turn.renderedAnswer = renderMarkdown(turn.answer)
              turn.followUp = (event.data.followUp as string[]) || []
              if (event.data.conversationId) {
                setActiveConversation(event.data.conversationId as string)
                syncConversationList(event.data.conversationId as string)
              }
              break

            case 'error':
              turn.error = (event.data.error as string) || '未知错误'
              break
          }

          await scrollToBottom()
        } catch {
          // 忽略单帧 JSON 解析错误
        }
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted) {
      turn.aborted = true
    } else {
      turn.error = '查询超时或失败，请检查模型服务后重试'
    }
  } finally {
    clearInterval(elapsedTimer)
    turn.loading = false
    currentAbortController.value = null
    await scrollToBottom()
    // 一轮结束后同步会话列表（标题/排序）与记忆（问答可能沉淀新记忆）。
    void refreshConversations()
    void refreshMemories()
  }
}

// ---- Agent 模式（SSE） ----
async function fetchAgentAnswer(q: string) {
  if (!q) return

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
  })
  history.value.push(turn)
  await scrollToBottom()

  const elapsedTimer = setInterval(() => {
    turn.elapsed++
  }, 1000)
  const ctrl = new AbortController()
  currentAbortController.value = ctrl

  try {
    const resp = await fetch('/api/agent/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, conversationId: activeConversationId.value }),
      credentials: 'include',
      signal: ctrl.signal,
    })

    if (!resp.ok) {
      if (resp.status === 401) {
        router.push('/login')
        return
      }
      turn.error = `请求失败: ${resp.status}`
      return
    }

    const reader = resp.body?.getReader()
    if (!reader) {
      turn.error = '无法建立流式连接'
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr) continue

        try {
          const event = JSON.parse(jsonStr) as {
            type: string
            data: Record<string, unknown>
          }

          switch (event.type) {
            case 'conversation':
              if (event.data.conversationId) {
                setActiveConversation(event.data.conversationId as string)
                syncConversationList(event.data.conversationId as string)
              }
              break

            case 'plan':
              turn.planSteps = (event.data.planSteps as string[]) ?? []
              break

            case 'thinking':
              turn.steps!.push({
                type: 'thinking',
                thought: event.data.thought as string,
              })
              break

            case 'tool_call':
              turn.steps!.push({
                type: 'tool_call',
                toolName: event.data.toolName as string,
                toolArgs: event.data.toolArgs as Record<string, unknown>,
              })
              break

            case 'tool_result':
              turn.steps!.push({
                type: 'tool_result',
                toolResult: event.data.toolResult as string,
              })
              break

            case 'answer_delta':
              turn.answer += event.data.delta as string
              turn.renderedAnswer = renderMarkdown(turn.answer)
              break

            case 'done':
              turn.answer = (event.data.answer as string) || turn.answer
              turn.renderedAnswer = renderMarkdown(turn.answer)
              turn.followUp = (event.data.followUp as string[]) || []
              turn.stepsCollapsed = true
              break

            case 'error':
              turn.error = (event.data.error as string) || '未知错误'
              break
          }

          await scrollToBottom()
        } catch {
          // 忽略 JSON 解析错误
        }
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted) {
      turn.aborted = true
    } else if (!turn.error) {
      turn.error = '连接中断或超时'
    }
  } finally {
    clearInterval(elapsedTimer)
    turn.loading = false
    currentAbortController.value = null
    await scrollToBottom()
    // 一轮结束后同步会话列表（标题/排序）与记忆（问答可能沉淀新记忆）。
    void refreshConversations()
    void refreshMemories()
  }
}

async function scrollToBottom() {
  await nextTick()
  // 滚动正在加载的 turn 的思考步骤区域到底部
  for (const [idx, el] of Object.entries(stepsBodyRefs.value)) {
    const turn = history.value[Number(idx)]
    if (turn?.loading && el) {
      el.scrollTop = el.scrollHeight
    }
  }
  if (conversationRef.value) {
    conversationRef.value.scrollTop = conversationRef.value.scrollHeight
  }
}

function handleAsk() {
  const q = newQuestion.value.trim()
  if (!q || isAnyLoading.value) return
  newQuestion.value = ''

  if (mode.value === 'agent') {
    fetchAgentAnswer(q)
  } else {
    fetchAnswer(q)
  }
}

function askFollowUp(q: string) {
  if (isAnyLoading.value) return
  if (mode.value === 'agent') {
    fetchAgentAnswer(q)
  } else {
    fetchAnswer(q)
  }
}

// 显式切项目 = 开一条新会话：清空活动会话 id 并清空 history（旧会话已在后端留库）。
// 同时刷新侧栏会话列表与项目记忆（两者均随当前项目变化）。
watch(currentRepo, (newRepo, oldRepo) => {
  if (oldRepo && newRepo && newRepo !== oldRepo) {
    clearActiveConversation()
    history.value = []
    void refreshConversations()
    void refreshMemories()
  }
})

onMounted(async () => {
  // 窄屏默认收起侧栏（移动端友好），宽屏默认展开。
  if (window.innerWidth <= 768) sidebarCollapsed.value = true
  // 进入页面即加载侧栏数据（会话列表 + 项目记忆）。
  void refreshConversations()
  void refreshMemories()

  const query = { ...route.query }
  if ('q' in query) {
    delete query.q
    void router.replace({ name: 'Answer', query, hash: route.hash })
  }

  // 先恢复活动会话（刷新/重进）：若会话归属项目与当前项目不一致则视为无效、起空会话。
  const { conversation, turns } = await restoreConversation(renderMarkdown)
  if (conversation && conversation.projectId === currentProjectId.value) {
    history.value = turns.map(t => reactive(t))
  } else if (conversation) {
    clearActiveConversation()
  }

  // 再处理首页带来的新问题，追加到已恢复的 history 之后。
  const pendingQuestion = consumePendingQuestion()
  if (pendingQuestion) {
    if (mode.value === 'agent') {
      void fetchAgentAnswer(pendingQuestion)
    } else {
      void fetchAnswer(pendingQuestion)
    }
  }

  await scrollToBottom()
  inputRef.value?.focus()
})
</script>

<!-- scoped 样式外置到 ./AnswerView.styles.css（保留 scoped 语义，含 :deep() 穿透 v-html 渲染的 markdown） -->
<style scoped src="./AnswerView.styles.css"></style>
