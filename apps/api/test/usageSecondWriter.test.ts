/**
 * 成本追踪 · §11.3.1：eval runner 是 app.db 的第二个写进程（交付评审 P1 的回归）。
 *
 * WAL 之下仍是单写者：另一连接持写锁时，本侧写入等 busy_timeout，超时拿 SQLITE_BUSY。
 * 这里断言 §16.4 末条要求的两条出路——要么写成功，要么**明确降级并计数**，
 * 绝不允许「写失败但账面看起来完整」。
 *
 * 用第二个 better-sqlite3 连接模拟"API server 进程"：SQLite 写锁按连接算，
 * 语义与真正跨进程一致。AIOPS_SQLITE_BUSY_TIMEOUT_MS 调短等待，用例不必真等 5 秒。
 */
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const TMP_DB = path.join(os.tmpdir(), `aiops-usage-second-writer-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;
process.env.AIOPS_SQLITE_BUSY_TIMEOUT_MS = '80';

const { createUsageTracker } = await import('../src/services/usage/usageTracker.ts');
const { getTurnEvents } = await import('../src/db/usageStore.ts');
const { initDb } = await import('../src/db/sqlite.ts');

// 先让本侧完成建库/迁移，再开"对方进程"的连接——锁竞争要发生在写 turn/event 上，不是迁移上
initDb();
const rival = new Database(TMP_DB);

afterAll(() => {
  rival.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

const RECORD = {
  provider: 'deepseek' as const,
  model: 'deepseek-v4-flash',
  transportStatus: 'success' as const,
  deliveryMode: 'non_stream' as const,
  rawUsage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  latencyMs: 3,
};

describe('§11.3.1 · 第二写进程的锁竞争', () => {
  it('对方持写锁：event 写入降级为内存计数，摘要必须带 partial 标记', () => {
    const t = createUsageTracker({ projectId: 'p1', pipeline: 'eval', source: 'eval' });
    expect(t.degraded).toBe(false);

    rival.exec('BEGIN IMMEDIATE'); // "API server" 持写锁
    try {
      t.record({ ...RECORD, stage: 'eval.judge' });
    } finally {
      rival.exec('ROLLBACK');
    }

    const s = t.finish('completed');
    // 失败不许伪装成零成本：必须计数 + partial，绝不静默
    expect(s.droppedUsageRecords).toBe(1);
    expect(s.partial).toBe(true);
    expect(s.partialReasons).toContain('tracking_write_failed');
    expect(getTurnEvents(t.turnId)).toHaveLength(0);
  });

  it('对方持写锁时连 turn 都建不了 → 降级为内存 tracker，调用数可还原为"未持久化 N 次"', () => {
    rival.exec('BEGIN IMMEDIATE');
    let t;
    try {
      t = createUsageTracker({ projectId: 'p1', pipeline: 'eval', source: 'eval' });
    } finally {
      rival.exec('ROLLBACK');
    }
    expect(t.degraded).toBe(true);

    // 降级后照常可用（评测不中断），只是全部留在内存
    t.record({ ...RECORD, stage: 'eval.judge' });
    const s = t.finish('completed');
    expect(s.callCount).toBe(1);
    expect(s.partial).toBe(true);
    expect(s.partialReasons).toContain('tracking_write_failed');
  });

  it('无锁竞争：eval turn 正常落库，parent_turn_id/pipeline/source 对方连接可见', () => {
    const t = createUsageTracker({ projectId: 'p1', pipeline: 'eval', source: 'eval', parentTurnId: 'parent-1' });
    t.record({ ...RECORD, stage: 'eval.judge' });
    const s = t.finish('completed');
    expect(s.callCount).toBe(1);
    expect(s.partial).toBe(false);

    // "对方进程"（rival 连接）能读到 → 真正写进了共享 DB，而不是本连接的幻觉
    const row = rival
      .prepare('SELECT pipeline, source, parent_turn_id FROM llm_usage_turns WHERE turn_id = ?')
      .get(t.turnId) as { pipeline: string; source: string; parent_turn_id: string };
    expect(row).toMatchObject({ pipeline: 'eval', source: 'eval', parent_turn_id: 'parent-1' });
    expect(getTurnEvents(t.turnId)).toHaveLength(1);
    expect(getTurnEvents(t.turnId)[0].stage).toBe('eval.judge');
  });
});
