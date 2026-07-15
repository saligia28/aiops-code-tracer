/**
 * L2 引用准确率 · 纯函数单测（确定性、hermetic：fixture 建在临时目录，CI 无条件可跑）
 *
 * 运行：pnpm --filter @aiops/api test citation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Evidence } from '@aiops/shared-types';
import { citationAccuracy } from './citation.ts';

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-fixture-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src/order.ts'),
    [
      'import { api } from "./api";',            // 1
      '',                                        // 2
      'export function voidOrder(id: string) {', // 3
      '  return api.post("/order/void", { id });', // 4
      '}',                                       // 5
      '',                                        // 6
      'export const pageSize = 20;',             // 7
    ].join('\n'),
  );
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const ev = (file: string, line: number, code: string): Evidence => ({ file, line, code, label: 'test' });

describe('L2 引用准确率 · citationAccuracy', () => {
  it('真实引用：行存在且标识符命中 → matched', () => {
    const r = citationAccuracy([ev('src/order.ts', 3, 'function voidOrder')], repo);
    expect(r.accuracy).toBe(1);
    expect(r.checks[0]).toMatchObject({ fileExists: true, lineExists: true, matched: true });
    expect(r.checks[0].actualLine).toContain('voidOrder');
  });

  it('行号偏差在容差内（±2）仍算命中——node.loc 对变换后源码可能偏行', () => {
    const r = citationAccuracy([ev('src/order.ts', 5, 'voidOrder')], repo);
    expect(r.checks[0].matched).toBe(true);
  });

  it('幻觉行号：超出文件行数 → lineExists=false，不算 matched', () => {
    const r = citationAccuracy([ev('src/order.ts', 42, 'function voidOrder')], repo);
    expect(r.checks[0]).toMatchObject({ fileExists: true, lineExists: false, matched: false });
    expect(r.accuracy).toBe(0);
  });

  it('幻觉文件：文件不存在 → fileExists=false', () => {
    const r = citationAccuracy([ev('src/ghost.ts', 1, 'anything')], repo);
    expect(r.checks[0]).toMatchObject({ fileExists: false, matched: false });
  });

  it('张冠李戴：行存在但声称的标识符附近根本没有 → matched=false', () => {
    const r = citationAccuracy([ev('src/order.ts', 1, 'function fetchUserProfile')], repo);
    expect(r.checks[0]).toMatchObject({ lineExists: true, matched: false });
  });

  it('纯中文标签（无标识符可核）：行存在即匹配', () => {
    const r = citationAccuracy([ev('src/order.ts', 7, '分页默认值')], repo);
    expect(r.checks[0].matched).toBe(true);
  });

  it('混合批次算准确率：2 真 1 假 → 2/3', () => {
    const r = citationAccuracy(
      [
        ev('src/order.ts', 3, 'voidOrder'),
        ev('src/order.ts', 7, 'pageSize'),
        ev('src/order.ts', 42, 'ghostFn'),
      ],
      repo,
    );
    expect(r.accuracy).toBeCloseTo(2 / 3);
  });

  it('空 evidence：约定返回 1（空真——没引用就没说错；覆盖率是另一个指标）', () => {
    expect(citationAccuracy([], repo).accuracy).toBe(1);
  });
});
