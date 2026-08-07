import { ref } from 'vue';
import type { ConversationTurn } from './useConversation';

/**
 * 流会话单例(切会话中断修复·方案 A):
 * 把"正在 streaming 的一轮问答"从 AnswerView 的 history(视图投影)里拆出来独立持有——
 * 切换会话只换投影,后台的 SSE reader 继续往本会话的 turns 里写,切回时整组还原。
 * 模块级单例:全局同一时刻最多一条流(与输入框单流门控一致),路由离开再回也能接上。
 */
export interface StreamSession {
  /** 流所属会话的 key:已有会话=真实会话 id;新会话拿到 id 前=临时 key(pending:N) */
  key: string;
  /** 后端回带的真实会话 id(agent 的 conversation 事件 / rag 的 done 帧后填充) */
  conversationId: string | null;
  /** 该会话完整 turns 数组的引用——流式 turn 是最后一个元素,切回时直接整组还原 */
  turns: ConversationTurn[];
  /** 中止句柄:只有显式停止/删会话/切项目才调用,切会话不再中止 */
  ctrl: AbortController;
}

const session = ref<StreamSession | null>(null);

let tempKeySeq = 0;
/** 新会话(尚无后端 id)的临时视图 key;真实会话 id 是 UUID,前缀空间不重叠 */
function nextTempKey(): string {
  tempKeySeq += 1;
  return `pending:${tempKeySeq}`;
}

/** 开始一条流。调用方保证同一时刻只有一条(输入框已按 streamRunning 门控)。 */
function beginStream(s: StreamSession): void {
  session.value = s;
}

/**
 * 后端回带会话 id:填充 conversationId 并把 key 重挂为真实 id(侧栏点击/切回按 key 匹配)。
 * 返回重挂前的旧 key,供调用方判断"用户是否仍停留在这条流的视图"——
 * 归属判断必须用旧 key:重挂后新 key 永远不等于还停留在临时 key 上的视图。
 */
function attachConversationId(id: string): string | null {
  const s = session.value;
  if (!s) return null;
  const prevKey = s.key;
  s.conversationId = id;
  s.key = id;
  return prevKey;
}

/** 流结束(done/error/abort 的 finally):清空单例。 */
function endStream(): void {
  session.value = null;
}

export function useStreamSession() {
  return { session, nextTempKey, beginStream, attachConversationId, endStream };
}
