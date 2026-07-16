import crypto from 'crypto';
import type { Memory, MemoryKind } from '@aiops/shared-types';
import { getDb } from './sqlite.js';

// ============================================================
// 记忆存储：全部同步（better-sqlite3 同步），DB 行 ↔ 领域类型映射。
// 本层保持「纯粹」——只做 CRUD + 打分排序 + 向量 blob 编解码，不触网、不调 LLM；
// embedding 由 service 层（memoryService）算好后传入（架构边界，别在这里发网络请求）。
// ============================================================

interface MemoryRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  kind: string;
  content: string;
  created_at: number;
  embedding: Buffer | null;
  embed_model: string | null;
  last_used_at: number | null;
}

/** DB 行 → 领域类型。embedding 等 v2 字段是内部实现细节，刻意不进 Memory（不外泄给 API）。 */
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

// ---- 向量 blob 编解码：Float32 小端字节 ↔ number[] ----
function embeddingToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
function blobToEmbedding(buf: Buffer): number[] {
  // 复制成独立 buffer 再视图，规避 Buffer 池化导致的 byteOffset 错位
  const f32 = new Float32Array(Uint8Array.from(buf).buffer);
  return Array.from(f32);
}

/**
 * 轻量本地分词：ASCII 词（字母/数字/下划线）+ CJK 相邻 bigram（如"状态管理"→ 状态/态管/管理），
 * 去重为 Set。用 bigram 而非单字，避免中文因共享常用字（的/是/在…）产生大量弱相关命中。
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

/** 两 token 集合的 Jaccard 相似度（交集 / 并集），用于文本近重复判定。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ============================================================
// 写入
// ============================================================

/** recordMemories 的入参项：embedding 可选（service 层算好传入；缺省则该行 embedding=NULL，召回退关键词）。 */
export interface MemoryDraft {
  kind: MemoryKind;
  content: string;
  embedding?: number[];
  embedModel?: string;
}

/**
 * 逐条插入记忆：content 去空白、跳空串；**文本近重复去噪**——与该 project 近 100 条已有
 * 记忆（及本批已插入项）Jaccard ≥ 0.6 即跳过。语义近重复（换个说法但意思相同）由 service
 * 层在写入前用 embedding 余弦判定后跳过，这里只兜底文本层。返回实际插入的记忆。
 */
export function recordMemories(
  projectId: string,
  conversationId: string | null,
  items: MemoryDraft[],
): Memory[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO memories (id, project_id, conversation_id, kind, content, created_at, embedding, embed_model, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
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
      if (seen.some((s) => jaccard(tok, s) >= 0.6)) continue;
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      insert.run(
        id, projectId, conversationId, item.kind, content, createdAt,
        item.embedding ? embeddingToBlob(item.embedding) : null,
        item.embedding ? (item.embedModel ?? null) : null,
        null, // last_used_at：尚未被检索命中
      );
      inserted.push({ id, projectId, conversationId, kind: item.kind, content, createdAt });
      seen.push(tok);
    }
  });
  tx();
  return inserted;
}

// ============================================================
// 检索
// ============================================================

/** 关键词打分：query 与 content 的 token 交集大小。 */
function keywordScore(queryTokens: Set<string>, content: string): number {
  const contentTokens = tokenize(content);
  let score = 0;
  for (const t of queryTokens) if (contentTokens.has(t)) score += 1;
  return score;
}

/**
 * 混合检索（记忆 v2）：关键词 + 语义（若给了 queryEmbedding）用 RRF 融合，命中的记忆更新
 * last_used_at（遗忘信号）。queryEmbedding 为 null（未配 embedding / 无已向量化记忆）时
 * 退化为纯关键词，行为等同 v1。
 *
 * 为什么用 RRF 而非加权求和：关键词分（交集计数，整数）与余弦分（0~1 小数）刻度不可比，
 * 加权调不准（与语义召回通道踩过同一个坑）；RRF 只比较「排名」，天然可融合。
 * 遗忘：并列时按 last_used_at（回退 created_at）新的优先——久未命中的自然沉底。
 * 真正的「删除遗忘」是 pruneStaleMemories（opt-in，不在此自动触发）。
 */
export function retrieveMemoriesHybrid(
  projectId: string,
  query: string,
  queryEmbedding: number[] | null,
  embedModel: string | null,
  limit: number,
): Memory[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(projectId) as MemoryRow[];
  if (rows.length === 0) return [];

  const RRF_K = 60;
  const queryTokens = tokenize(query);

  // 关键词排名（score>0 才入榜）
  const kwRanked = rows
    .map((row) => ({ row, s: keywordScore(queryTokens, row.content) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const kwRank = new Map<string, number>();
  kwRanked.forEach((x, i) => kwRank.set(x.row.id, i + 1));

  // 语义排名（仅对「同模型的已向量化记忆」算余弦，且过余弦下限）。
  // 下限很关键：无下限时余弦再低的无关记忆也会入选，把不相关记忆注进 prompt——
  // 而 v1 关键词无命中时是「不注入任何记忆」，破坏这个干净行为就是回归。
  const SEM_MIN_COSINE = Number(process.env.MEMORY_SEM_MIN_COSINE || '') || 0.6;
  const semRank = new Map<string, number>();
  if (queryEmbedding && embedModel) {
    const semRanked = rows
      .filter((row) => row.embedding && row.embed_model === embedModel)
      .map((row) => ({ row, s: cosine(queryEmbedding, blobToEmbedding(row.embedding!)) }))
      .filter((x) => x.s >= SEM_MIN_COSINE)
      .sort((a, b) => b.s - a.s);
    semRanked.forEach((x, i) => semRank.set(x.row.id, i + 1));
  }

  // RRF 融合：只要在任一通道命中就入选
  const fused = rows
    .map((row) => {
      const kr = kwRank.get(row.id);
      const sr = semRank.get(row.id);
      if (kr === undefined && sr === undefined) return null;
      const score = (kr ? 1 / (RRF_K + kr) : 0) + (sr ? 1 / (RRF_K + sr) : 0);
      return { row, score };
    })
    .filter((x): x is { row: MemoryRow; score: number } => x !== null)
    .sort((a, b) => b.score - a.score
      || (b.row.last_used_at ?? b.row.created_at) - (a.row.last_used_at ?? a.row.created_at));

  const picked = fused.slice(0, limit);

  // 命中即更新 last_used_at（遗忘信号）——失败不影响返回
  if (picked.length > 0) {
    try {
      const now = Date.now();
      const upd = db.prepare('UPDATE memories SET last_used_at = ? WHERE id = ?');
      const tx = db.transaction(() => { for (const p of picked) upd.run(now, p.row.id); });
      tx();
    } catch {
      // 忽略：更新使用时间失败不该影响检索结果
    }
  }

  return picked.map((p) => mapMemory(p.row));
}

/** 纯关键词检索（v1 语义保留，供无 embedding 的场景/测试用）。 */
export function retrieveMemories(projectId: string, query: string, limit: number): Memory[] {
  return retrieveMemoriesHybrid(projectId, query, null, null, limit);
}

// ============================================================
// 向量回填 & 语义去重支撑（供 service 层）
// ============================================================

/** 该 project 有多少条同模型的已向量化记忆——用于「值不值得为召回 embed 一次 query」的闸门。 */
export function countEmbeddedMemories(projectId: string, embedModel: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE project_id = ? AND embed_model = ? AND embedding IS NOT NULL')
    .get(projectId, embedModel) as { n: number };
  return row.n;
}

/** 该 project 已向量化（同模型）的记忆的 {id, content, embedding}，供写入前语义近重复判定。 */
export function getEmbeddedMemories(projectId: string, embedModel: string): Array<{ id: string; content: string; embedding: number[] }> {
  const rows = getDb()
    .prepare('SELECT id, content, embedding FROM memories WHERE project_id = ? AND embed_model = ? AND embedding IS NOT NULL')
    .all(projectId, embedModel) as Array<{ id: string; content: string; embedding: Buffer }>;
  return rows.map((r) => ({ id: r.id, content: r.content, embedding: blobToEmbedding(r.embedding) }));
}

/** 尚未向量化（或模型不匹配）的记忆，供后台回填。 */
export function listMemoriesNeedingEmbedding(projectId: string, embedModel: string, limit = 50): Array<{ id: string; content: string }> {
  return getDb()
    .prepare('SELECT id, content FROM memories WHERE project_id = ? AND (embedding IS NULL OR embed_model IS NOT ?) ORDER BY created_at DESC LIMIT ?')
    .all(projectId, embedModel, limit) as Array<{ id: string; content: string }>;
}

/** 写入/更新一条记忆的向量。 */
export function setMemoryEmbedding(id: string, embedding: number[], embedModel: string): void {
  getDb()
    .prepare('UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?')
    .run(embeddingToBlob(embedding), embedModel, id);
}

// ============================================================
// 列举 / 删除
// ============================================================

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

/**
 * 遗忘（删除）：清除「从未被检索命中过，且创建时间早于 staleDays 天」的记忆。
 * 只删从未命中的（last_used_at IS NULL），命中过的一律保留——被用过 = 有价值。
 * ⚠️ 会真删数据，属破坏性操作，故不在任何路径自动调用。
 * TODO(记忆 v2 后续): 由定时任务或索引重建时显式触发；接线前先在评测里确认删除策略不误伤。
 */
export function pruneStaleMemories(projectId: string, staleDays: number): number {
  // 语义：删「至少 staleDays 天前创建」的。用 <= 而非 <——staleDays=0 表示"所有已存在的"，
  // 且规避同毫秒边界（创建与清理落在同一毫秒时 < 会漏删）。
  const cutoff = Date.now() - staleDays * 24 * 3600 * 1000;
  const info = getDb()
    .prepare('DELETE FROM memories WHERE project_id = ? AND last_used_at IS NULL AND created_at <= ?')
    .run(projectId, cutoff);
  return info.changes;
}
