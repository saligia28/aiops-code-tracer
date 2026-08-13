import { createStore, useStore } from '@/lib/store';
import type { TokenUsageEvent, TurnUsageSummary } from './useTokenUsage';
import http from '@/lib/http';

// 后端契约类型（来自 @aiops/shared-types，但 web 暂未接入该别名，就地写最小 interface 以能 typecheck）。
export type ChatRole = 'user' | 'assistant' | 'system';
export type ChatMode = 'rag' | 'agent';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  mode?: ChatMode;
  /** 富信息：followUp / elapsed / steps / error / aborted 等 */
  meta?: Record<string, unknown> | null;
  createdAt: number; // epoch ms
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

export type MemoryKind = string;

export interface Memory {
  id: string;
  projectId: string;
  conversationId: string | null;
  kind: MemoryKind;
  content: string;
  createdAt: number; // epoch ms
}

// Agent 思考步骤（与 AnswerView 内同名结构对齐，仅用于从 meta.steps 还原）。
interface AgentStep {
  type: 'thinking' | 'tool_call' | 'tool_result';
  thought?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
}

// 与 AnswerView.tsx 内的 ConversationTurn 同形（不直接 import 组件，就地最小声明，保持解耦）。
export interface ConversationTurn {
  question: string;
  answer: string;
  renderedAnswer: string;
  followUp: string[];
  loading: boolean;
  error: string;
  elapsed: number;
  aborted?: boolean;
  steps?: AgentStep[];
  stepsCollapsed?: boolean;
  planSteps?: string[];
  /** 本轮成本汇总（成本追踪·阶段 4）：SSE done 带来，或刷新时从 message meta 还原 */
  tokenUsageSummary?: TurnUsageSummary;
  /** 展开后按需拉取的调用明细 */
  tokenUsageEvents?: TokenUsageEvent[];
  isSystemDivider?: boolean;
  systemText?: string;
}

/** Markdown 渲染函数（由 AnswerView 注入，复用其已有 marked 实例，避免另造）。 */
type RenderMarkdown = (text: string) => string;

const STORAGE_KEY = 'aiops-active-conversation';

const activeConversationStore = createStore<string | null>(localStorage.getItem(STORAGE_KEY));

/** 非组件上下文（SSE 回调里）要读的当前活动会话 id。 */
export function getActiveConversationId(): string | null {
  return activeConversationStore.get();
}

export function setActiveConversation(id: string | null): void {
  activeConversationStore.set(id);
  if (id) {
    localStorage.setItem(STORAGE_KEY, id);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function clearActiveConversation(): void {
  setActiveConversation(null);
}

/**
 * 把按时间正序的消息配对还原成 ConversationTurn[]：
 * - role==='user' → 开一个新 turn（question=content，loading=false）。
 * - role==='assistant' → 填最近一个尚未填回答的 turn；若无（孤儿 assistant）则单独成一 turn。
 * - role==='system' → 作为 isSystemDivider 分隔行。
 * 孤儿 user（无后续 assistant）保持 loading=false 展示为一问。
 */
export function messagesToTurns(
  messages: ConversationMessage[],
  renderMarkdown: RenderMarkdown,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  // 指向「最近一个等待 assistant 回答」的 turn；为 null 表示需要新开。
  let pending: ConversationTurn | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      pending = {
        question: msg.content,
        answer: '',
        renderedAnswer: '',
        followUp: [],
        loading: false,
        error: '',
        elapsed: 0,
      };
      turns.push(pending);
      continue;
    }

    if (msg.role === 'assistant') {
      const meta = (msg.meta ?? {}) as Record<string, unknown>;
      const target: ConversationTurn = pending ?? {
        question: '',
        answer: '',
        renderedAnswer: '',
        followUp: [],
        loading: false,
        error: '',
        elapsed: 0,
      };
      target.answer = msg.content;
      target.renderedAnswer = renderMarkdown(msg.content);
      target.followUp = (meta.followUp as string[]) ?? [];
      target.elapsed = (meta.elapsed as number) ?? 0;
      target.error = (meta.error as string) ?? '';
      if (meta.steps !== undefined) {
        target.steps = meta.steps as AgentStep[];
        target.stepsCollapsed = true;
      }
      if (meta.planSteps !== undefined) {
        target.planSteps = meta.planSteps as string[];
      }
      // 刷新/切会话后仍能看到本轮花了多少钱（设计文档 §18.8）
      if (meta.tokenUsageSummary !== undefined) {
        target.tokenUsageSummary = meta.tokenUsageSummary as TurnUsageSummary;
      }
      if (meta.aborted !== undefined) {
        target.aborted = meta.aborted as boolean;
      }
      if (!pending) {
        turns.push(target);
      }
      pending = null;
      continue;
    }

    // system → 分隔行
    pending = null;
    turns.push({
      question: '',
      answer: '',
      renderedAnswer: '',
      followUp: [],
      loading: false,
      error: '',
      elapsed: 0,
      isSystemDivider: true,
      systemText: msg.content,
    });
  }

  return turns;
}

/**
 * 恢复当前活动会话：
 * - activeConversationId 为空 → 返回 []。
 * - GET /api/conversations/:id 成功 → 返回 { conversation, turns }。
 * - 404 或出错 → clearActiveConversation() 并返回 { conversation: null, turns: [] }。
 * （projectId 校验交由调用方用 currentProjectId 比对 conversation.projectId。）
 */
export async function restoreConversation(
  renderMarkdown: RenderMarkdown,
): Promise<{ conversation: Conversation | null; turns: ConversationTurn[] }> {
  const id = activeConversationStore.get();
  if (!id) return { conversation: null, turns: [] };

  try {
    const res = await http.get<ConversationWithMessages>(`/api/conversations/${id}`);
    const { messages, ...conversation } = res.data;
    return {
      conversation: conversation as Conversation,
      turns: messagesToTurns(messages, renderMarkdown),
    };
  } catch {
    clearActiveConversation();
    return { conversation: null, turns: [] };
  }
}

/**
 * 加载任意会话（用于侧栏点击切换）：
 * - GET /api/conversations/:id → 用 messagesToTurns 还原为 turns（注入调用方的 renderMarkdown，复用其 marked 实例）。
 * - 不在此处改 activeConversationId，由调用方决定何时 setActiveConversation（与 restoreConversation 对称，保持纯函数式）。
 */
export async function loadConversation(
  id: string,
  renderMarkdown: RenderMarkdown,
): Promise<{ conversation: Conversation; turns: ConversationTurn[] }> {
  const res = await http.get<ConversationWithMessages>(`/api/conversations/${id}`);
  const { messages, ...conversation } = res.data;
  return {
    conversation: conversation as Conversation,
    turns: messagesToTurns(messages, renderMarkdown),
  };
}

/** 当前项目的会话列表（updated_at 倒序，由后端保证排序）。 */
export async function listConversations(): Promise<Conversation[]> {
  const res = await http.get<Conversation[]>('/api/conversations');
  return res.data;
}

/** 重命名会话 → PATCH /api/conversations/:id。 */
export async function renameConversation(id: string, title: string): Promise<Conversation> {
  const res = await http.patch<Conversation>(`/api/conversations/${id}`, { title });
  return res.data;
}

/** 删除会话 → DELETE /api/conversations/:id。 */
export async function deleteConversation(id: string): Promise<void> {
  await http.delete(`/api/conversations/${id}`);
}

/** 当前项目的记忆列表。 */
export async function listMemories(): Promise<Memory[]> {
  const res = await http.get<Memory[]>('/api/memories');
  return res.data;
}

/** 删除一条记忆 → DELETE /api/memories/:id。 */
export async function deleteMemory(id: string): Promise<void> {
  await http.delete(`/api/memories/${id}`);
}

/**
 * 相对时间：把 epoch ms 渲染成「刚刚 / N 分钟前 / N 小时前 / N 天前 / yyyy-mm-dd」。
 * 侧栏会话与记忆列表共用。容错非法/缺省时间为空串。
 */
export function relativeTime(ts?: number | null): string {
  if (!ts || Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function useConversation() {
  const activeConversationId = useStore(activeConversationStore);

  return {
    activeConversationId,
    getActiveConversationId,
    setActiveConversation,
    clearActiveConversation,
    messagesToTurns,
    restoreConversation,
    loadConversation,
    listConversations,
    renameConversation,
    deleteConversation,
    listMemories,
    deleteMemory,
  };
}
