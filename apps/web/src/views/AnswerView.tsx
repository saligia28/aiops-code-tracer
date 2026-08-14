import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Popconfirm } from 'antd';
import { message } from '@/components/antd/feedback';
import { prompt } from '@/components/antd/prompt';
import { Scrollbar } from '@/components/Scrollbar';
import { TokenUsagePanel } from '@/components/TokenUsagePanel';
import { useCurrentRepo } from '@/hooks/useCurrentRepo';
import { useProject } from '@/hooks/useProject';
import {
  useConversation,
  relativeTime,
  type Conversation,
  type Memory,
} from '@/hooks/useConversation';
import { consumePendingQuestion } from '@/hooks/usePendingQuestion';
import { useStreamSession, getStreamSession } from '@/hooks/useStreamSession';
import { useTokenUsageState, type TokenUsageEvent, type TurnUsageSummary } from '@/hooks/useTokenUsage';
import { nextTick } from '@/lib/dom';
import './AnswerView.css';

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
  /** Agent 执行计划（P1-C plan 事件），一次性下发的步骤清单 */
  planSteps?: string[];
  /** 本轮成本汇总（成本追踪·阶段 4） */
  tokenUsageSummary?: TurnUsageSummary;
  /** 展开后按需拉取的调用明细 */
  tokenUsageEvents?: TokenUsageEvent[];
  // 系统分隔消息
  isSystemDivider?: boolean;
  systemText?: string;
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

function conversationLabel(c: Conversation): string {
  const title = c.title?.trim();
  return title || '未命名会话';
}

export default function AnswerView() {
  const { currentRepo } = useCurrentRepo();
  const { currentProjectId } = useProject();
  const {
    activeConversationId,
    getActiveConversationId,
    setActiveConversation,
    clearActiveConversation,
    restoreConversation,
    loadConversation,
    listConversations,
    renameConversation,
    deleteConversation,
    listMemories,
    deleteMemory,
  } = useConversation();

  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const conversationRef = useRef<HTMLElement | null>(null);
  const stepsBodyRefs = useRef<Record<number, HTMLElement>>({});
  const [newQuestion, setNewQuestion] = useState('');
  const [mode, setMode] = useState<AnswerMode>('agent');

  /**
   * 对话历史用 ref + 强制重渲染来驱动：SSE 每来一个 token 就地改 turn 对象，
   * 再 bump 一次渲染 —— 与迁移前 Vue reactive(turn) 的写法一一对应，
   * 也避免了在流式循环里反复重建数组带来的闭包/丢帧问题。
   */
  const historyRef = useRef<ConversationTurn[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const history = historyRef.current;

  const { session: streamSession, nextTempKey, beginStream, attachConversationId, endStream } =
    useStreamSession();

  // 当前视图 key：查看已落库会话=会话 id；新会话（未落库）=null，首问时铸临时 key。
  // ref 与 state 并行：SSE 回调是长活闭包，只能通过 ref 读到最新值。
  const [currentViewKey, setCurrentViewKeyState] = useState<string | null>(activeConversationId);
  const currentViewKeyRef = useRef<string | null>(currentViewKey);
  function setCurrentViewKey(key: string | null) {
    currentViewKeyRef.current = key;
    setCurrentViewKeyState(key);
  }

  // 全局是否有流在跑（单流门控：输入框停用）/ 当前视图是否就是那条流（停止按钮、自动滚动）
  const streamRunning = streamSession !== null;
  const viewOwnsStream = streamSession !== null && streamSession.key === currentViewKey;
  /** 流循环里判归属只能实时读，不能用渲染期算好的 viewOwnsStream（闭包会过期）。 */
  function ownsStreamNow(): boolean {
    const s = getStreamSession();
    return s !== null && s.key === currentViewKeyRef.current;
  }

  function handleAbort() {
    getStreamSession()?.ctrl.abort();
  }

  // ---- 左侧栏：会话列表 + 记忆面板 ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [memoryFolded, setMemoryFolded] = useState(false);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);

  const refreshConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      setConversations(await listConversations());
    } catch {
      // 列表拉取失败静默：不阻断问答主流程
    } finally {
      setConversationsLoading(false);
    }
  }, [listConversations]);

  const refreshMemories = useCallback(async () => {
    setMemoriesLoading(true);
    try {
      setMemories(await listMemories());
    } catch {
      // 同上，静默失败
    } finally {
      setMemoriesLoading(false);
    }
  }, [listMemories]);

  const {
    getState: getUsageState,
    loading: usageLoading,
    fetchDetail,
    startPolling,
    stopPolling,
  } = useTokenUsageState();

  const scrollToBottom = useCallback(async () => {
    await nextTick();
    // 滚动正在加载的 turn 的思考步骤区域到底部
    for (const [idx, el] of Object.entries(stepsBodyRefs.current)) {
      const turn = historyRef.current[Number(idx)];
      if (turn?.loading && el) {
        el.scrollTop = el.scrollHeight;
      }
    }
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, []);

  /**
   * 从 done 帧接住本轮成本。未结算（还有后台任务在跑）时启动轮询，
   * 结算后自动停；30 秒仍未结算就停下等用户刷新，不无限占着请求。
   */
  const captureUsage = useCallback(
    (turn: ConversationTurn, data: Record<string, unknown>): void => {
      const summary = data.tokenUsageSummary as TurnUsageSummary | undefined;
      if (!summary) return;
      turn.tokenUsageSummary = summary;
      if (!summary.settled) {
        startPolling(summary.turnId, (fresh) => {
          turn.tokenUsageSummary = fresh;
          turn.tokenUsageEvents = getUsageState().events[fresh.turnId];
          bump();
        });
      }
      bump();
    },
    [startPolling, getUsageState],
  );

  /**
   * 恢复会话后的续轮询（§12.4，评审 P6）：message meta 里的 summary 是当时写库的快照，
   * 服务端多半早已结算完（后台任务秒级/watchdog 强制结算）。恢复到未结算快照时重新轮询，
   * 否则"成本结算中"会一直挂着，直到用户手动展开明细才被动刷新一次。
   */
  const resumeUsagePolling = useCallback((): void => {
    for (const turn of historyRef.current) {
      const s = turn.tokenUsageSummary;
      if (!s || s.settled) continue;
      // 旧回调可能还绑在已被替换的 turn 对象上——先停再起，让新视图的 turn 接住结算更新
      stopPolling(s.turnId);
      startPolling(s.turnId, (fresh) => {
        turn.tokenUsageSummary = fresh;
        turn.tokenUsageEvents = getUsageState().events[fresh.turnId];
        bump();
      });
    }
  }, [startPolling, stopPolling, getUsageState]);

  /** 展开时才拉明细：一轮 agent 可能几十条 event，没必要每次问答都传 */
  async function loadUsageDetail(turn: ConversationTurn): Promise<void> {
    const turnId = turn.tokenUsageSummary?.turnId;
    if (!turnId || turn.tokenUsageEvents?.length) return;
    const summary = await fetchDetail(turnId);
    turn.tokenUsageEvents = getUsageState().events[turnId] ?? [];
    if (summary) turn.tokenUsageSummary = summary;
    bump();
  }

  // 新建会话：清空视图起一条干净会话。后台流（如有）继续跑完并由后端落库，完成后可从侧栏切回
  function startNewConversation() {
    clearActiveConversation();
    historyRef.current = [];
    setCurrentViewKey(null);
    bump();
    if (window.innerWidth <= 768) setSidebarCollapsed(true);
  }

  // 切换会话：活流会话直接还原内存 turns；其余 GET 该会话消息 → messagesToTurns 还原
  async function switchConversation(id: string) {
    if (id === currentViewKey) {
      if (window.innerWidth <= 768) setSidebarCollapsed(true);
      return;
    }
    // 切到正在 streaming 的会话：还原内存 turns（assistant 还没落库，GET 会缺最后一轮），不打请求
    const live = getStreamSession();
    if (live && live.key === id) {
      historyRef.current = live.turns;
      setCurrentViewKey(id);
      setActiveConversation(id);
      bump();
      if (window.innerWidth <= 768) setSidebarCollapsed(true);
      await scrollToBottom();
      return;
    }
    try {
      const { turns } = await loadConversation(id, renderMarkdown);
      historyRef.current = turns;
      bump();
      resumeUsagePolling();
      setCurrentViewKey(id);
      setActiveConversation(id);
      if (window.innerWidth <= 768) setSidebarCollapsed(true);
      await scrollToBottom();
    } catch {
      message.error('加载会话失败');
    }
  }

  // 重命名：弹 prompt → PATCH → 局部更新列表。
  async function renameConversationPrompt(c: Conversation) {
    let title: string;
    try {
      title = (
        await prompt({
          title: '重命名会话',
          message: '请输入新的会话名称',
          okText: '确定',
          cancelText: '取消',
          defaultValue: c.title ?? '',
          placeholder: '会话名称',
        })
      ).trim();
    } catch {
      return; // 取消
    }
    if (!title || title === c.title) return;
    try {
      const updated = await renameConversation(c.id, title);
      setConversations((prev) => {
        const idx = prev.findIndex((x) => x.id === c.id);
        if (idx === -1) {
          void refreshConversations();
          return prev;
        }
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
    } catch {
      message.error('重命名失败');
    }
  }

  // 删除：DELETE → 若删的是当前视图/活动会话则清空 history + 活动 id → 刷新列表。
  async function removeConversation(c: Conversation) {
    try {
      // 删除正在 streaming 的会话：先中止流（继续为已删除的会话生成没有意义；
      // 服务端中止落库会因会话已删而失败，只留 error 日志，可接受）
      const live = getStreamSession();
      if (live?.key === c.id) live.ctrl.abort();
      await deleteConversation(c.id);
      if (c.id === activeConversationId || c.id === currentViewKey) {
        clearActiveConversation();
        historyRef.current = [];
        setCurrentViewKey(null);
        bump();
      }
      await refreshConversations();
    } catch {
      message.error('删除会话失败');
    }
  }

  async function removeMemory(m: Memory) {
    try {
      await deleteMemory(m.id);
      setMemories((prev) => prev.filter((x) => x.id !== m.id));
    } catch {
      message.error('删除记忆失败');
    }
  }

  // 本轮提问拿到 conversationId 后刷新会话列表：新会话首次出现、或已存在会话 updated_at
  // 变化导致重排/标题更新，都需要重新拉取一次以保持顺序与标题同步。
  function syncConversationList(conversationId: string | null | undefined) {
    if (!conversationId) return;
    void refreshConversations();
  }

  // 后端回带会话 id：重挂流会话 key；仅当用户仍停留在这条流的视图时才落活动会话——
  // 无条件 setActiveConversation 会在用户已切走时把侧栏高亮/localStorage 强行拉回（A 之前的隐性 bug）
  function onStreamConversationId(id: string): void {
    const prevKey = attachConversationId(id);
    if (prevKey !== null && prevKey === currentViewKeyRef.current) {
      setCurrentViewKey(id);
      setActiveConversation(id);
    } else if (currentViewKeyRef.current === id) {
      // 视图已停在这条会话上（切走期间经 GET 加载过快照）：活流刚认领同一 id，
      // 快照缺流式轮，直接重绑活 turns
      const live = getStreamSession();
      if (live) {
        historyRef.current = live.turns;
        bump();
      }
    }
    syncConversationList(id);
  }

  // ---- RAG 模式 ----
  const fetchAnswer = useCallback(
    async (q: string) => {
      if (!q) return;

      const turn: ConversationTurn = {
        question: q,
        answer: '',
        renderedAnswer: '',
        followUp: [],
        loading: true,
        error: '',
        elapsed: 0,
      };
      // 就地 push 而非重建数组：流会话按引用持有这个数组，换新数组会让它写到孤儿副本里
      historyRef.current.push(turn);
      bump();
      await scrollToBottom();

      const elapsedTimer = setInterval(() => {
        turn.elapsed++;
        bump();
      }, 1000);
      const ctrl = new AbortController();
      // 流会话登记：视图无会话 id（新会话首问）时铸临时 key，后端回带 id 后重挂
      if (!currentViewKeyRef.current) setCurrentViewKey(nextTempKey());
      beginStream({
        key: currentViewKeyRef.current!,
        conversationId: getActiveConversationId(),
        turns: historyRef.current,
        ctrl,
      });

      try {
        // 流式（P1-D）：stream:true 走 SSE，answer_delta 逐 token 打字机渲染，
        // done 终帧带完整 AskResponse（answer/followUp/conversationId）收尾兜底。
        // 服务端对快速路径/降级路径会补一帧整体 delta，因此本解析器对所有路径通用。
        const resp = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, conversationId: getActiveConversationId(), stream: true }),
          credentials: 'include',
          signal: ctrl.signal,
        });

        if (!resp.ok) {
          if (resp.status === 401) {
            navigate('/login');
            return;
          }
          turn.error = `请求失败: ${resp.status}`;
          bump();
          return;
        }

        const reader = resp.body?.getReader();
        if (!reader) {
          turn.error = '无法建立流式连接';
          bump();
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
              const event = JSON.parse(jsonStr) as { type: string; data: Record<string, unknown> };

              switch (event.type) {
                case 'answer_delta':
                  turn.answer += event.data.delta as string;
                  turn.renderedAnswer = renderMarkdown(turn.answer);
                  break;

                case 'done':
                  // 以终帧为准（流式拼接与整包语义一致，这里兜底覆盖）
                  turn.answer = (event.data.answer as string) || turn.answer || '未能生成回答';
                  turn.renderedAnswer = renderMarkdown(turn.answer);
                  turn.followUp = (event.data.followUp as string[]) || [];
                  captureUsage(turn, event.data);
                  if (event.data.conversationId) {
                    onStreamConversationId(event.data.conversationId as string);
                  }
                  break;

                case 'error':
                  turn.error = (event.data.error as string) || '未知错误';
                  break;
              }

              bump();
              if (ownsStreamNow()) await scrollToBottom();
            } catch {
              // 忽略单帧 JSON 解析错误
            }
          }
        }
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted) {
          turn.aborted = true;
        } else {
          turn.error = '查询超时或失败，请检查模型服务后重试';
        }
      } finally {
        clearInterval(elapsedTimer);
        turn.loading = false;
        // 只清理本流自己的登记——挂载路径可能已有新流顶替，不能误清
        const owned = ownsStreamNow() && getStreamSession()?.ctrl === ctrl;
        if (getStreamSession()?.ctrl === ctrl) endStream();
        bump();
        if (owned) await scrollToBottom();
        // 一轮结束后同步会话列表（标题/排序）与记忆（问答可能沉淀新记忆）。
        void refreshConversations();
        void refreshMemories();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [captureUsage, refreshConversations, refreshMemories, scrollToBottom],
  );

  // ---- Agent 模式（SSE） ----
  const fetchAgentAnswer = useCallback(
    async (q: string) => {
      if (!q) return;

      const turn: ConversationTurn = {
        question: q,
        answer: '',
        renderedAnswer: '',
        followUp: [],
        loading: true,
        error: '',
        elapsed: 0,
        steps: [],
        stepsCollapsed: false,
      };
      // 就地 push 而非重建数组：流会话按引用持有这个数组，换新数组会让它写到孤儿副本里
      historyRef.current.push(turn);
      bump();
      await scrollToBottom();

      const elapsedTimer = setInterval(() => {
        turn.elapsed++;
        bump();
      }, 1000);
      const ctrl = new AbortController();
      // 流会话登记：视图无会话 id（新会话首问）时铸临时 key，后端回带 id 后重挂
      if (!currentViewKeyRef.current) setCurrentViewKey(nextTempKey());
      beginStream({
        key: currentViewKeyRef.current!,
        conversationId: getActiveConversationId(),
        turns: historyRef.current,
        ctrl,
      });

      try {
        const resp = await fetch('/api/agent/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: q, conversationId: getActiveConversationId() }),
          credentials: 'include',
          signal: ctrl.signal,
        });

        if (!resp.ok) {
          if (resp.status === 401) {
            navigate('/login');
            return;
          }
          turn.error = `请求失败: ${resp.status}`;
          bump();
          return;
        }

        const reader = resp.body?.getReader();
        if (!reader) {
          turn.error = '无法建立流式连接';
          bump();
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
                case 'conversation':
                  if (event.data.conversationId) {
                    onStreamConversationId(event.data.conversationId as string);
                  }
                  break;

                case 'plan':
                  turn.planSteps = (event.data.planSteps as string[]) ?? [];
                  break;

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
                  captureUsage(turn, event.data);
                  break;

                case 'error':
                  turn.error = (event.data.error as string) || '未知错误';
                  break;
              }

              bump();
              if (ownsStreamNow()) await scrollToBottom();
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
        // 只清理本流自己的登记——挂载路径可能已有新流顶替，不能误清
        const owned = ownsStreamNow() && getStreamSession()?.ctrl === ctrl;
        if (getStreamSession()?.ctrl === ctrl) endStream();
        bump();
        if (owned) await scrollToBottom();
        // 一轮结束后同步会话列表（标题/排序）与记忆（问答可能沉淀新记忆）。
        void refreshConversations();
        void refreshMemories();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [captureUsage, refreshConversations, refreshMemories, scrollToBottom],
  );

  function handleAsk() {
    const q = newQuestion.trim();
    if (!q || streamRunning) return;
    setNewQuestion('');

    if (mode === 'agent') {
      void fetchAgentAnswer(q);
    } else {
      void fetchAnswer(q);
    }
  }

  // 显式切项目 = 开一条新会话：清空活动会话 id 并清空 history（旧会话已在后端留库）。
  // 同时刷新侧栏会话列表与项目记忆（两者均随当前项目变化）。
  const previousRepo = useRef<string | null>(null);
  useEffect(() => {
    const oldRepo = previousRepo.current;
    previousRepo.current = currentRepo;
    if (oldRepo === null) return; // 首帧只记录，不当作切换
    if (oldRepo && currentRepo && currentRepo !== oldRepo) {
      // 旧项目的流没有归宿：显式中止（服务端会落库部分答案），避免它继续往旧项目会话里写
      getStreamSession()?.ctrl.abort();
      clearActiveConversation();
      historyRef.current = [];
      setCurrentViewKey(null);
      bump();
      void refreshConversations();
      void refreshMemories();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRepo]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      // 窄屏默认收起侧栏（移动端友好），宽屏默认展开。
      if (window.innerWidth <= 768) setSidebarCollapsed(true);
      // 进入页面即加载侧栏数据（会话列表 + 项目记忆）。
      void refreshConversations();
      void refreshMemories();

      if (searchParams.has('q')) {
        const next = new URLSearchParams(searchParams);
        next.delete('q');
        setSearchParams(next, { replace: true });
      }

      // 先取出首页带来的新问题：有则视为「从首页发起」，应开一条全新会话，不接续上次活动会话；
      // 无则是刷新 / 直接重进问答页，才恢复上次活动会话（保持刷新态）。
      const pendingQuestion = consumePendingQuestion();
      if (pendingQuestion) {
        // 从首页发起新问题 = 新意图：旧的后台流（若有）显式中止（服务端会落库部分答案）
        getStreamSession()?.ctrl.abort();
        // 从首页进入 = 新会话：清掉活动会话 id 与历史，提问时 conversationId 为空 → 后端新建会话。
        clearActiveConversation();
        historyRef.current = [];
        setCurrentViewKey(null);
        bump();
      } else {
        // 路由离开再回来且流还在跑：优先还原内存活流（库里还没有 assistant 消息）
        const live = getStreamSession();
        if (live && live.key === getActiveConversationId()) {
          historyRef.current = live.turns;
          setCurrentViewKey(live.key);
          bump();
          // 离开路由时停掉了所有成本轮询，回来后本会话更早的未结算轮要接着轮
          resumeUsagePolling();
        } else {
          // 刷新 / 重进：恢复活动会话，若会话归属项目与当前项目不一致则视为无效、起空会话。
          const { conversation, turns } = await restoreConversation(renderMarkdown);
          if (cancelled) return;
          if (conversation && conversation.projectId === currentProjectId) {
            historyRef.current = turns;
            bump();
            resumeUsagePolling();
          } else if (conversation) {
            clearActiveConversation();
          }
          setCurrentViewKey(getActiveConversationId());
        }
      }

      // 发起首页带来的问题（此时 activeConversationId 已清空，后端会新建会话）。
      if (pendingQuestion) {
        if (mode === 'agent') {
          void fetchAgentAnswer(pendingQuestion);
        } else {
          void fetchAnswer(pendingQuestion);
        }
      }

      await scrollToBottom();
      inputRef.current?.focus();
    }

    void boot();
    return () => {
      cancelled = true;
    };
    // 仅在挂载时跑一次，等价迁移前的 onMounted。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const turns = useMemo(() => history, [history]);

  return (
    <div className="answer-page">
      {/* 顶部导航 */}
      <header className="top-bar">
        <button className="back-btn" onClick={() => navigate('/')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          className={`sidebar-toggle${sidebarCollapsed ? ' is-collapsed' : ''}`}
          title={sidebarCollapsed ? '展开会话栏' : '收起会话栏'}
          onClick={() => setSidebarCollapsed((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <div className="brand" onClick={() => navigate('/')}>
          <ProjectIcon size={28} />
          <span>逻瞳</span>
        </div>
        {/* 模式切换 */}
        <div className="mode-switch">
          <button
            className={`mode-btn${mode === 'rag' ? ' active' : ''}`}
            onClick={() => setMode('rag')}
          >
            普通模式
          </button>
          <button
            className={`mode-btn${mode === 'agent' ? ' active' : ''}`}
            onClick={() => setMode('agent')}
          >
            Agent 模式
          </button>
        </div>
      </header>

      {/* 主体：左侧会话栏 + 右侧对话/输入列 */}
      <div className="body-shell">
        {/* 移动端遮罩：展开时点击空白处收起 */}
        {!sidebarCollapsed && (
          <div className="sidebar-backdrop" onClick={() => setSidebarCollapsed(true)} />
        )}

        {/* 左侧会话 + 记忆侧栏 */}
        <aside className={`session-sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`}>
          {/* 会话列表（上半部） */}
          <div className="sidebar-section conversations-section">
            <button className="new-chat-btn" onClick={startNewConversation}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>新建会话</span>
            </button>

            <Scrollbar className="conversations-scroll">
              {conversationsLoading ? (
                <div className="sidebar-status">加载中...</div>
              ) : conversations.length === 0 ? (
                <div className="sidebar-empty">暂无会话，提问后自动创建</div>
              ) : (
                <ul className="conversation-list">
                  {conversations.map((c) => (
                    <li
                      key={c.id}
                      className={`conversation-item${c.id === currentViewKey ? ' active' : ''}`}
                      onClick={() => switchConversation(c.id)}
                    >
                      <div className="conv-main">
                        <span className="conv-title">{conversationLabel(c)}</span>
                        {streamSession?.key === c.id && (
                          <span className="conv-streaming-dot" title="生成中" />
                        )}
                        <span className="conv-time">{relativeTime(c.updatedAt)}</span>
                      </div>
                      <div className="conv-actions">
                        <button
                          className="conv-action-btn"
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation();
                            void renameConversationPrompt(c);
                          }}
                        >
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <Popconfirm
                          title="确定删除该会话？"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          placement="bottom"
                          onConfirm={() => void removeConversation(c)}
                        >
                          <button
                            className="conv-action-btn conv-delete"
                            title="删除"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </Popconfirm>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Scrollbar>
          </div>

          {/* 记忆面板（下半部，可折叠） */}
          <div className={`sidebar-section memory-section${memoryFolded ? ' is-folded' : ''}`}>
            <div className="memory-header" onClick={() => setMemoryFolded((v) => !v)}>
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`chevron-icon${memoryFolded ? '' : ' chevron-open'}`}
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              <span className="memory-title">项目记忆</span>
              {memories.length > 0 && <span className="memory-count">{memories.length}</span>}
            </div>
            <Scrollbar
              className="memory-scroll"
              style={{ display: memoryFolded ? 'none' : undefined }}
            >
              {memoriesLoading ? (
                <div className="sidebar-status">加载中...</div>
              ) : memories.length === 0 ? (
                <div className="sidebar-empty">暂无记忆，问答后会自动沉淀</div>
              ) : (
                <ul className="memory-list">
                  {memories.map((m) => (
                    <li key={m.id} className="memory-item">
                      <div className="memory-content">{m.content}</div>
                      <div className="memory-meta">
                        <span className="memory-time">{relativeTime(m.createdAt)}</span>
                        <Popconfirm
                          title="删除这条记忆？"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          placement="bottom"
                          onConfirm={() => void removeMemory(m)}
                        >
                          <button
                            className="memory-delete"
                            title="删除"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </Popconfirm>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Scrollbar>
          </div>
        </aside>

        {/* 右侧对话 + 输入列 */}
        <div className="main-col">
          {/* 对话区域 */}
          <main className="conversation" ref={conversationRef}>
            {turns.map((turn, idx) => (
              <div key={idx} className="turn">
                {/* 系统分隔消息 */}
                {turn.isSystemDivider ? (
                  <div className="system-divider">
                    <span className="divider-line" />
                    <span className="divider-text">{turn.systemText}</span>
                    <span className="divider-line" />
                  </div>
                ) : (
                  /* 正常对话 */
                  <>
                    <div className="question-bubble">
                      <div className="bubble-content">{turn.question}</div>
                    </div>

                    {/* AI 回答 */}
                    <div className="answer-section">
                      <div className="ai-avatar">
                        <ProjectIcon size={26} />
                      </div>
                      <div className="answer-body">
                        {/* Agent 执行计划（P1-C）：plan 事件一次性下发，服务端暂无逐步完成状态——
                            只如实展示计划本身，不伪造勾选进度 */}
                        {turn.planSteps && turn.planSteps.length > 0 && (
                          <div className="agent-plan">
                            <div className="agent-plan-header">
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
                                <rect x="9" y="3" width="6" height="4" rx="1" />
                                <path d="M9 12h6M9 16h6" />
                              </svg>
                              <span className="plan-label">执行计划（{turn.planSteps.length} 步）</span>
                            </div>
                            <ol className="agent-plan-list">
                              {turn.planSteps.map((planStep, pi) => (
                                <li key={pi}>{planStep}</li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {/* Agent 思考步骤 */}
                        {turn.steps && turn.steps.length > 0 && (
                          <div className="agent-steps">
                            <div
                              className="agent-steps-header"
                              onClick={() => {
                                turn.stepsCollapsed = !turn.stepsCollapsed;
                                bump();
                              }}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="14"
                                height="14"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className={`chevron-icon${turn.stepsCollapsed ? '' : ' chevron-open'}`}
                              >
                                <path d="M9 18l6-6-6-6" />
                              </svg>
                              <span className="steps-label">思考过程（{turn.steps.length} 步）</span>
                              {turn.loading && <span className="steps-loading-dot" />}
                            </div>
                            <div
                              className="agent-steps-body"
                              style={{ display: turn.stepsCollapsed ? 'none' : undefined }}
                              ref={(el) => {
                                if (el) stepsBodyRefs.current[idx] = el;
                              }}
                            >
                              {turn.steps.map((step, si) => (
                                <div key={si} className="agent-step">
                                  {step.type === 'thinking' ? (
                                    <>
                                      <div className="step-icon step-thinking-icon">💭</div>
                                      <div className="step-content step-thinking">{step.thought}</div>
                                    </>
                                  ) : step.type === 'tool_call' ? (
                                    <>
                                      <div className="step-icon step-tool-icon">🔧</div>
                                      <div className="step-content step-tool">
                                        <span className="tool-name">{step.toolName}</span>
                                        <code className="tool-args">{formatArgs(step.toolArgs)}</code>
                                      </div>
                                    </>
                                  ) : step.type === 'tool_result' ? (
                                    <>
                                      <div className="step-icon step-result-icon">📋</div>
                                      <div className="step-content step-result">{step.toolResult}</div>
                                    </>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 加载状态 */}
                        {turn.loading ? (
                          <div className="loading-indicator">
                            <div className="typing-dots">
                              <span />
                              <span />
                              <span />
                            </div>
                            <span className="loading-text">
                              {turn.steps && turn.steps.length > 0
                                ? 'Agent 正在分析代码...'
                                : '正在阅读代码并分析...'}
                            </span>
                            {turn.elapsed > 0 && <span className="loading-elapsed">{turn.elapsed}s</span>}
                          </div>
                        ) : turn.error ? (
                          /* 错误状态 */
                          <div className="error-msg">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="15" y1="9" x2="9" y2="15" />
                              <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            {turn.error}
                          </div>
                        ) : (
                          /* 正常/中止：有部分答案照常渲染，中止轮追加徽标
                             （部分答案不再被"已中止"吞掉） */
                          <>
                            {turn.renderedAnswer && (
                              <div
                                className="answer-content markdown-body"
                                dangerouslySetInnerHTML={{ __html: turn.renderedAnswer }}
                              />
                            )}
                            {turn.aborted && (
                              <div className="aborted-msg">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="8" y1="12" x2="16" y2="12" />
                                </svg>
                                <span>{turn.answer ? '已中止——以上为中止前的部分回答' : '已中止'}</span>
                              </div>
                            )}
                          </>
                        )}

                        {/* 耗时标签 */}
                        {!turn.loading && !turn.error && !turn.aborted && turn.elapsed > 0 && (
                          <div className="answer-duration">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <polyline points="12 6 12 12 16 14" />
                            </svg>
                            <span>耗时 {turn.elapsed}s</span>
                          </div>
                        )}

                        {/* 本轮 Token 成本（成本追踪·阶段 4）：默认只有一行摘要，点开才拉明细 */}
                        {turn.tokenUsageSummary && !turn.loading && (
                          <TokenUsagePanel
                            summary={turn.tokenUsageSummary}
                            events={turn.tokenUsageEvents}
                            loading={usageLoading[turn.tokenUsageSummary.turnId]}
                            onExpand={() => void loadUsageDetail(turn)}
                          />
                        )}

                        {/* 追问建议 TODO:暂时也不要这个模块功能，后续打磨后开放 */}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ))}
          </main>

          {/* 底部输入 */}
          <footer className="input-bar">
            <div className="input-box">
              <input
                ref={inputRef}
                value={newQuestion}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder={
                  streamRunning && !viewOwnsStream
                    ? '另一会话正在生成中，完成后可继续提问'
                    : '继续提问...'
                }
                onKeyUp={(e) => {
                  if (e.key === 'Enter') handleAsk();
                }}
                disabled={streamRunning}
              />
              {viewOwnsStream ? (
                <button className="stop-btn" onClick={handleAbort} title="中止">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={handleAsk}
                  disabled={!newQuestion.trim() || streamRunning}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              )}
            </div>
          </footer>
        </div>
        {/* /main-col */}
      </div>
      {/* /body-shell */}
    </div>
  );
}
