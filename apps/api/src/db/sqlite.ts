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
