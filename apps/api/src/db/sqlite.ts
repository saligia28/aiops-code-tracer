import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../context.js';

// ============================================================
// 对话持久化的 SQLite 基座：惰性单例 + user_version 迁移 + WAL
// ============================================================

/**
 * DB 路径：默认 `data/.aiops/app.db`（顶层，与 projects.json 同级，
 * 避免被重建索引产物波及）。`AIOPS_DB_PATH` 可覆盖（测试用临时库/`:memory:`）。
 */
function resolveDbPath(): string {
  return process.env.AIOPS_DB_PATH || path.join(DATA_DIR, 'app.db');
}

let db: Database.Database | null = null;

/**
 * 极简版本迁移：用 `PRAGMA user_version` 做版本控制，可重入。
 * 每一档迁移在单独事务里跑，按 user_version 递增判断。
 */
function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number;

  if (current < 1) {
    const toV1 = database.transaction(() => {
      database.exec(`
        CREATE TABLE conversations (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          title       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          archived    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_conv_project ON conversations(project_id, updated_at DESC);
        CREATE TABLE messages (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role            TEXT NOT NULL,
          content         TEXT NOT NULL,
          mode            TEXT,
          meta            TEXT,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_msg_conv ON messages(conversation_id, created_at);
      `);
      database.pragma('user_version = 1');
    });
    toV1();
  }

  if (current < 2) {
    const toV2 = database.transaction(() => {
      database.exec(`
        CREATE TABLE memories (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL,
          conversation_id TEXT,
          kind            TEXT NOT NULL,
          content         TEXT NOT NULL,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_mem_project ON memories(project_id, created_at DESC);
      `);
      database.pragma('user_version = 2');
    });
    toV2();
  }

  // v3（记忆 v2 / P2-F）：给 memories 加语义召回与遗忘所需字段。全部 additive、可空——
  // 旧记忆 embedding=NULL 时召回自动退回纯关键词，embedding 未配置时整条通道 dormant，零回归。
  //   embedding    Float32 向量的小端字节（存 BLOB，读时按 embed_model 校验维度/模型）
  //   embed_model  该向量出自哪个 embedding 模型（换模型后旧向量作废，避免跨模型算余弦）
  //   last_used_at 最近一次被检索命中的时间戳（遗忘信号：久未命中的记忆排序降权）
  if (current < 3) {
    const toV3 = database.transaction(() => {
      database.exec(`
        ALTER TABLE memories ADD COLUMN embedding BLOB;
        ALTER TABLE memories ADD COLUMN embed_model TEXT;
        ALTER TABLE memories ADD COLUMN last_used_at INTEGER;
      `);
      database.pragma('user_version = 3');
    });
    toV3();
  }

  // v4（上下文工程 / P2-H）：给 conversations 加「早期历史摘要」缓存。additive 可空，零回归——
  //   summary          早期历史的 LLM 摘要正文（NULL = 从未摘要，历史窗口走纯截断）
  //   summary_covered  摘要已覆盖「过滤后历史消息列表」的前多少条
  // 水位用条数而非时间戳：消息 append-only、条数前缀稳定；created_at 同毫秒并列时
  // 时间戳水位会误判边界（一条没进摘要的消息被当成已覆盖 → 内容凭空丢失）。
  if (current < 4) {
    const toV4 = database.transaction(() => {
      database.exec(`
        ALTER TABLE conversations ADD COLUMN summary TEXT;
        ALTER TABLE conversations ADD COLUMN summary_covered INTEGER;
      `);
      database.pragma('user_version = 4');
    });
    toV4();
  }

  // v5（写侧第二刀 / P2-G apply·HITL）：补丁提案持久化 + 落盘审计。
  //   patch_proposals   propose 时落库（status=proposed），apply 按 id 审批——审批的正是校验过的原件；
  //                     snapshot_json 在 apply 时写入（每个文件的原始字节 base64 + 落盘后 sha），回滚据此写回。
  //   patch_apply_audit apply/rollback/apply_rejected 的审计流水（谁何时改了什么、结果、是否回滚）。
  if (current < 5) {
    const toV5 = database.transaction(() => {
      database.exec(`
        CREATE TABLE patch_proposals (
          id             TEXT PRIMARY KEY,
          repo_name      TEXT NOT NULL,
          question       TEXT NOT NULL,
          unified_diff   TEXT NOT NULL,
          files_json     TEXT NOT NULL,
          verify_json    TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'proposed',
          validated_at   TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          applied_at     INTEGER,
          rolled_back_at INTEGER,
          snapshot_json  TEXT
        );
        CREATE INDEX idx_patch_repo ON patch_proposals(repo_name, created_at DESC);
        CREATE TABLE patch_apply_audit (
          id          TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          action      TEXT NOT NULL,
          result      TEXT NOT NULL,
          detail      TEXT,
          at          INTEGER NOT NULL
        );
        CREATE INDEX idx_patch_audit ON patch_apply_audit(proposal_id, at);
      `);
      database.pragma('user_version = 5');
    });
    toV5();
  }
}

/**
 * 惰性单例：首次打开时确保父目录存在、开 WAL、跑迁移。
 */
export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  migrate(database);

  db = database;
  return db;
}

/**
 * 启动时提前初始化（建表 / 尽早暴露打开或迁移错误）。等价于调用一次 `getDb()`。
 */
export function initDb(): void {
  getDb();
}
