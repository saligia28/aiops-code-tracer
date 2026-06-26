import crypto from 'crypto';
import type { Memory, MemoryKind } from '@aiops/shared-types';
import { getDb } from './sqlite.js';

// ============================================================
// 记忆存储：全部同步（better-sqlite3 同步），DB 行 ↔ 领域类型映射
// ============================================================

interface MemoryRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  kind: string;
  content: string;
  created_at: number;
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    kind: row.kind as MemoryKind,
    content: row.content,
    createdAt: row.created_at,
  };
}

/**
 * 轻量本地分词：ASCII 词（字母/数字/下划线）+ CJK 相邻 bigram（如"状态管理"→ 状态/态管/管理），
 * 去重为 Set。用 bigram 而非单字，避免中文因共享常用字（的/是/在…）产生大量弱相关命中。
 * 仅供记忆检索打分 / 近重复判定用，不引入 ask 管线依赖。
 */
function tokenize(s: string): Set<string> {
  const l = s.toLowerCase();
  const tokens: string[] = [...(l.match(/[a-z0-9_]+/g) ?? [])];
  for (const run of l.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return new Set(tokens);
}

/** 两 token 集合的 Jaccard 相似度（交集 / 并集），用于近重复判定。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// ============================================================
// 写入 / 检索 / 列举 / 删除
// ============================================================

/**
 * 逐条插入记忆：content 去首尾空白、跳过空串；**近重复去噪**——与该 project 近 100 条
 * 已有记忆（及本批已插入项）的 token 集合 Jaccard ≥ 0.6 即视为重复跳过（含完全相同、轻微改写）。
 * 这样即便每轮都抽取，重复事实也不会把记忆表撑满。返回实际插入的记忆（时间正序）。
 */
export function recordMemories(
  projectId: string,
  conversationId: string | null,
  items: { kind: MemoryKind; content: string }[],
): Memory[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO memories (id, project_id, conversation_id, kind, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // 近重复判定基线：该 project 最近 100 条记忆的 token 集合
  const existingRows = db
    .prepare('SELECT content FROM memories WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(projectId) as { content: string }[];
  const seen: Set<string>[] = existingRows.map((r) => tokenize(r.content));

  const inserted: Memory[] = [];
  const tx = db.transaction(() => {
    for (const item of items) {
      const content = item.content.trim();
      if (!content) continue;
      const tok = tokenize(content);
      // 近重复（含完全相同、轻微改写）跳过
      if (seen.some((s) => jaccard(tok, s) >= 0.6)) continue;
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      insert.run(id, projectId, conversationId, item.kind, content, createdAt);
      inserted.push({ id, projectId, conversationId, kind: item.kind, content, createdAt });
      seen.push(tok); // 本批内也去重
    }
  });
  tx();

  return inserted;
}

/**
 * 检索记忆：取该 project 最近 200 条，按 query 与 memory.content 的「关键词重合度」
 * 打分（两侧 token 集合的交集大小），返回 score>0 的前 limit 条。
 * 排序：score 降序，并列按 created_at 降序。
 */
export function retrieveMemories(projectId: string, query: string, limit: number): Memory[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC LIMIT 200',
    )
    .all(projectId) as MemoryRow[];

  const queryTokens = tokenize(query);

  const scored: { memory: Memory; score: number }[] = [];
  for (const row of rows) {
    const contentTokens = tokenize(row.content);
    let score = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) score += 1;
    }
    if (score > 0) {
      scored.push({ memory: mapMemory(row), score });
    }
  }

  // score 降序；并列按 created_at 降序
  scored.sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt);

  return scored.slice(0, limit).map((s) => s.memory);
}

/** 该 project 全部记忆，created_at 倒序。 */
export function listMemories(projectId: string): Memory[] {
  const rows = getDb()
    .prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as MemoryRow[];
  return rows.map(mapMemory);
}

/** 按 id 删除一条记忆。 */
export function deleteMemory(id: string): void {
  getDb().prepare('DELETE FROM memories WHERE id = ?').run(id);
}
