import crypto from 'crypto';
import type {
  ChatMode,
  ChatRole,
  Conversation,
  ConversationMessage,
  ConversationWithMessages,
} from '@aiops/shared-types';
import { getDb } from './sqlite.js';

// ============================================================
// 对话存储：全部同步（better-sqlite3 同步），DB 行 ↔ 领域类型映射
// ============================================================

interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  mode: string | null;
  meta: string | null;
  created_at: number;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived !== 0,
  };
}

function mapMessage(row: MessageRow): ConversationMessage {
  let meta: Record<string, unknown> | null = null;
  if (row.meta != null) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ChatRole,
    content: row.content,
    mode: (row.mode ?? undefined) as ChatMode | undefined,
    meta,
    createdAt: row.created_at,
  };
}

/** 轻量本地 token 估算（CJK 偏多，不引入 ask 管线依赖）。 */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

// ============================================================
// 会话
// ============================================================

export function createConversation(projectId: string, title?: string): Conversation {
  const now = Date.now();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(id, projectId, title ?? null, now, now);
  return {
    id,
    projectId,
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
}

export function getConversation(id: string): Conversation | null {
  const row = getDb()
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined;
  return row ? mapConversation(row) : null;
}

export function getConversationWithMessages(id: string): ConversationWithMessages | null {
  const conversation = getConversation(id);
  if (!conversation) return null;
  return { ...conversation, messages: getMessages(id) };
}

export function listConversations(projectId: string): Conversation[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as ConversationRow[];
  return rows.map(mapConversation);
}

export function renameConversation(id: string, title: string): void {
  getDb()
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title, Date.now(), id);
}

export function deleteConversation(id: string): void {
  const db = getDb();
  const tx = db.transaction((conversationId: string) => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  });
  tx(id);
}

// ============================================================
// 消息
// ============================================================

export function appendMessage(
  conversationId: string,
  m: { role: ChatRole; content: string; mode?: ChatMode; meta?: unknown },
): ConversationMessage {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const metaJson = m.meta == null ? null : JSON.stringify(m.meta);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, mode, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, conversationId, m.role, m.content, m.mode ?? null, metaJson, now);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
  });
  tx();

  return {
    id,
    conversationId,
    role: m.role,
    content: m.content,
    mode: m.mode,
    meta: (m.meta ?? null) as Record<string, unknown> | null,
    createdAt: now,
  };
}

export function getMessages(conversationId: string): ConversationMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as MessageRow[];
  return rows.map(mapMessage);
}

/** 进 LLM 历史窗口的一条消息（过滤后：user/assistant、内容非空）。 */
export interface HistoryEntry {
  role: ChatRole;
  content: string;
}

/**
 * 过滤后的历史消息列表（user/assistant、content 非空），时间正序。
 * 这是「窗口装配」与「摘要覆盖水位（summary_covered 条）」共用的唯一定义——
 * 两边过滤条件必须一致，否则水位会错位。
 */
export function getHistoryEntries(conversationId: string): HistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?
         AND role IN ('user', 'assistant')
         AND content <> ''
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Pick<MessageRow, 'role' | 'content'>[];
  return rows.map((r) => ({ role: r.role as ChatRole, content: r.content }));
}

/**
 * 装配多轮历史窗口（v1 纯截断）：从最新往旧累加 token，累计超过 tokenBudget 即停
 * （最旧先丢），最后反转为时间正序返回。只放自然语言问/答，绝不带检索代码块。
 * 带摘要的升级版入口见 services/ask/historyCompactor.ts 的 buildHistoryWindow（P2-H）。
 */
export function buildLlmHistory(
  conversationId: string,
  tokenBudget: number,
): { role: ChatRole; content: string }[] {
  const rows = getHistoryEntries(conversationId);

  const picked: { role: ChatRole; content: string }[] = [];
  let total = 0;
  // 从最新往旧累加，超预算即停（最旧先丢）
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rows[i].content);
    if (total + cost > tokenBudget) break;
    total += cost;
    picked.push({ role: rows[i].role, content: rows[i].content });
  }
  // 反转为时间正序
  picked.reverse();
  return picked;
}

// ============================================================
// 历史摘要缓存（P2-H）：conversations.summary / summary_covered
// ============================================================

export interface ConversationSummary {
  /** 早期历史的 LLM 摘要正文 */
  summary: string;
  /** 摘要已覆盖 getHistoryEntries 列表的前多少条 */
  covered: number;
}

export function getConversationSummary(conversationId: string): ConversationSummary | null {
  const row = getDb()
    .prepare('SELECT summary, summary_covered FROM conversations WHERE id = ?')
    .get(conversationId) as { summary: string | null; summary_covered: number | null } | undefined;
  if (!row || !row.summary || !row.summary_covered || row.summary_covered <= 0) return null;
  return { summary: row.summary, covered: row.summary_covered };
}

export function setConversationSummary(conversationId: string, summary: string, covered: number): void {
  getDb()
    .prepare('UPDATE conversations SET summary = ?, summary_covered = ? WHERE id = ?')
    .run(summary, covered, conversationId);
}
