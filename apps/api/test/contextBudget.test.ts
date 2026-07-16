import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getContextBudgets,
  getAgentCompressThresholds,
  parsePositiveInt,
} from '../src/services/ask/contextBudget.js';

// 每个用例前清空相关 env、结束后还原——预算模块每次现读 env，无需 reset 钩子
const KEYS = [
  'CONTEXT_CODE_BUDGET',
  'CONTEXT_EVIDENCE_BUDGET',
  'CONTEXT_GRAPH_BUDGET',
  'CONTEXT_HISTORY_BUDGET',
  'AGENT_COMPRESS_LIGHT_CHARS',
  'AGENT_COMPRESS_HEAVY_CHARS',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('contextBudget · env 解析', () => {
  it('env 未设置时返回收敛前的原默认值（零回归锚点）', () => {
    expect(getContextBudgets()).toEqual({ code: 6000, evidence: 1500, graph: 800, history: 1500 });
    expect(getAgentCompressThresholds()).toEqual({ lightChars: 20_000, heavyChars: 40_000 });
  });

  it('合法 env 覆盖生效', () => {
    process.env.CONTEXT_CODE_BUDGET = '8000';
    process.env.CONTEXT_HISTORY_BUDGET = '3000';
    const b = getContextBudgets();
    expect(b.code).toBe(8000);
    expect(b.history).toBe(3000);
    // 未覆盖的保持默认
    expect(b.evidence).toBe(1500);
  });

  it('非法值（非数字/负数/零/小数）一律回退默认，服务不受配错影响', () => {
    expect(parsePositiveInt('abc', 42)).toBe(42);
    expect(parsePositiveInt('-100', 42)).toBe(42);
    expect(parsePositiveInt('0', 42)).toBe(42);
    expect(parsePositiveInt('1.5', 42)).toBe(42);
    expect(parsePositiveInt('', 42)).toBe(42);
    expect(parsePositiveInt(undefined, 42)).toBe(42);
    expect(parsePositiveInt('100', 42)).toBe(100);

    process.env.CONTEXT_EVIDENCE_BUDGET = 'not-a-number';
    expect(getContextBudgets().evidence).toBe(1500);
  });

  it('压缩阈值倒挂（heavy ≤ light）时纠正为 light 的 2 倍，保持先轻后重', () => {
    process.env.AGENT_COMPRESS_LIGHT_CHARS = '30000';
    process.env.AGENT_COMPRESS_HEAVY_CHARS = '10000';
    expect(getAgentCompressThresholds()).toEqual({ lightChars: 30_000, heavyChars: 60_000 });
  });
});
