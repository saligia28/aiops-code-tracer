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

/**
 * 按项目归属解析会话：不存在或不属于该项目一律返回 null，调用方视作无效 id 处理。
 * 背景（review 修复）：getConversation 不做归属校验时，项目 A 的活会话 id 会在切到
 * 项目 B 后被静默复用——A 的历史进 B 的召回、B 的答案写进 A 的会话、记忆跨项目串染。
 * MCP 是第一个长期持有 conversationId 的客户端，这条路径从"理论上"变成了"必然发生"。
 */
export function getConversationForProject(id: string, projectId: string): Conversation | null {
  const conv = getConversation(id);
  return conv && conv.projectId === projectId ? conv : null;
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
    // 成本数据与会话同事务删除：留下 usage 行会让"删了会话还能查到花了多少钱"（设计文档 §4.4）。
    // 顺序上先删子表，避免中途失败留下悬挂 event。
    db.prepare(
      `DELETE FROM llm_usage_events WHERE turn_id IN
         (SELECT turn_id FROM llm_usage_turns WHERE conversation_id = ?)`,
    ).run(conversationId);
    db.prepare('DELETE FROM llm_usage_turns WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId);
  });
  tx(id);
}

// ============================================================
// 消息
// ============================================================

/**
 * 局部更新消息 meta（成本追踪 · 阶段 4）。
 *
 * 必须**合并**而不是整段覆盖：meta 里已经躺着 followUp / steps / planSteps / evidenceCount，
 * 直接写会把它们抹掉（刷新后 agent 轨迹和执行计划就没了）。
 * 消息不存在时静默 no-op——会话可能已被删除，成本回写不该报错。
 */
export function updateMessageMeta(messageId: string, patch: Record<string, unknown>): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare('SELECT meta FROM messages WHERE id = ?').get(messageId) as
      | { meta: string | null }
      | undefined;
    if (!row) return;
    let current: Record<string, unknown> = {};
    try {
      current = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    } catch {
      current = {};
    }
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(
      JSON.stringify({ ...current, ...patch }),
      messageId,
    );
  })();
}

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
  // rowid 次级排序：created_at 是毫秒精度，快速路径下同会话 user/assistant 可同毫秒落库，
  // SQL 对并列行顺序无保证——摘要水位按「条数前缀」记，前缀顺序必须绝对稳定
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
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
 * rowid 次级排序（review 修复）：同毫秒并列行的顺序 SQL 不保证，只靠索引扫描的
 * 实现细节碰巧稳定；水位按条数前缀记，顺序漂移 = 消息从摘要和窗口同时消失。
 */
export function getHistoryEntries(conversationId: string): HistoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content FROM messages
       WHERE conversation_id = ?
         AND role IN ('user', 'assistant')
         AND content <> ''
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(conversationId) as Pick<MessageRow, 'role' | 'content'>[];
  return rows.map((r) => ({ role: r.role as ChatRole, content: r.content }));
}

// v1 的 buildLlmHistory（纯截断窗口）已删除：生产路径全部走
// services/ask/historyCompactor.ts 的 buildHistoryWindow；它与正版 estimateTokens
// （CJK 感知）4.5× 漂移的本地估算器一并移除，避免双实现各改各的。

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
