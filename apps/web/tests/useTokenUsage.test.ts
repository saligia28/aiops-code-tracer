/**
 * useTokenUsage 的轮询纪律 + 面板展示纪律（设计文档 §16.6，评审 P6）。
 *
 * 组件（TokenUsagePanel）的显示规则已抽成纯函数（formatCostText / formatCallCountText /
 * canShowCacheHitRate），这里在 node 环境直接测决策逻辑——不引入 DOM 测试栈，
 * 覆盖的正是 §16.6 点名的三条纪律：¥0 纪律、partial 文案、混合模型隐藏命中率。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/http', () => ({ default: { get: vi.fn() } }));

import http from '@/lib/http';
import {
  useTokenUsage,
  formatNanoCny,
  formatTokens,
  formatLatency,
  formatCostText,
  formatCallCountText,
  canShowCacheHitRate,
  type TurnUsageSummary,
  type TokenUsageEvent,
} from '@/hooks/useTokenUsage';

const mockGet = vi.mocked(http.get);

function summary(over: Partial<TurnUsageSummary> = {}): TurnUsageSummary {
  return {
    turnId: 't1',
    executionStatus: 'completed',
    settlementStatus: 'settled',
    settled: true,
    partial: false,
    partialReasons: [],
    callCount: 3,
    usageMissingCalls: 0,
    unknownPricingCalls: 0,
    droppedUsageRecords: 0,
    lateDroppedEvents: 0,
    backgroundFailedJobs: 0,
    backgroundTimedOutJobs: 0,
    promptTokens: 1000,
    cacheHitTokens: 600,
    cacheMissTokens: 400,
    completionTokens: 200,
    reasoningTokens: 0,
    totalTokens: 1200,
    knownCostNanoCny: 812_000,
    updatedAt: 0,
    ...over,
  };
}

function event(over: Partial<TokenUsageEvent> = {}): TokenUsageEvent {
  return {
    id: 'e1',
    stage: 'ask.answer_complex',
    stageCallIndex: 0,
    model: 'deepseek-v4-flash',
    canonicalModel: 'deepseek-chat',
    transportStatus: 'success',
    usageSource: 'provider',
    deliveryMode: 'non_stream',
    tokens: { cacheHitTokens: 600, cacheMissTokens: 400, completionTokens: 200 },
    pricing: { matchKind: 'exact_model', supportsPromptCache: true },
    totalCostNanoCny: 812_000,
    latencyMs: 1200,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockGet.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('轮询纪律', () => {
  it('同一 turn 不允许两个 poller：重复 startPolling 被忽略', async () => {
    mockGet.mockResolvedValue({ data: { summary: summary({ settled: false, settlementStatus: 'pending' }), events: [] } });
    const t = useTokenUsage();
    t.startPolling('t1', () => {});
    t.startPolling('t1', () => {});
    await vi.advanceTimersByTimeAsync(1500);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('拿到 settled=true 即停：后续不再发请求', async () => {
    mockGet.mockResolvedValue({ data: { summary: summary({ settled: true }), events: [] } });
    const t = useTokenUsage();
    const onUpdate = vi.fn();
    t.startPolling('t1', onUpdate);
    await vi.advanceTimersByTimeAsync(1500);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('30 秒上限：一直未结算就停下等用户手动刷新，不无限占请求', async () => {
    mockGet.mockResolvedValue({ data: { summary: summary({ settled: false, settlementStatus: 'pending' }), events: [] } });
    const t = useTokenUsage();
    t.startPolling('t1', () => {});
    await vi.advanceTimersByTimeAsync(35_000);
    const callsAtCap = mockGet.mock.calls.length;
    // 1.5s 间隔 × 30s 上限 = 最多 20 次
    expect(callsAtCap).toBeGreaterThan(0);
    expect(callsAtCap).toBeLessThanOrEqual(20);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockGet).toHaveBeenCalledTimes(callsAtCap);
  });

  it('轮询失败不回调——宁可显示旧数据，不把已显示的成本抹成空白', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    const t = useTokenUsage();
    const onUpdate = vi.fn();
    t.startPolling('t1', onUpdate);
    await vi.advanceTimersByTimeAsync(4500);
    expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('stopAll 清空全部 poller（离开页面不留后台空转）', async () => {
    mockGet.mockResolvedValue({ data: { summary: summary({ settled: false, settlementStatus: 'pending' }), events: [] } });
    const t = useTokenUsage();
    t.startPolling('t1', () => {});
    t.startPolling('t2', () => {});
    t.stopAll();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('面板展示纪律（§13.2/§13.3）', () => {
  it('正成本永不显示 ¥0：低于展示精度显示 <¥0.000001', () => {
    expect(formatNanoCny(20)).toBe('<¥0.000001');
    expect(formatNanoCny(0)).toBe('¥0');
    expect(formatNanoCny(812_000)).toBe('¥0.000812');
  });

  it('partial 摘要 = "部分成本 ¥…"，不冒充完整总价', () => {
    expect(formatCostText(summary({ partial: true }))).toBe('部分成本 ¥0.000812');
    expect(formatCostText(summary())).toBe('¥0.000812');
  });

  it('写失败的 dropped 分开说，不混进精确分项', () => {
    expect(formatCallCountText(summary({ droppedUsageRecords: 2 }))).toBe('已记录 3 次，另有 2 次未持久化');
    expect(formatCallCountText(summary())).toBe('3 次调用');
  });

  it('混合模型隐藏总缓存命中率（Ollama 没有缓存，混着算没有意义）', () => {
    const deepseek = event();
    const ollama = event({ id: 'e2', canonicalModel: 'qwen3:8b', pricing: undefined });
    expect(canShowCacheHitRate([deepseek, ollama])).toBe(false);
    expect(canShowCacheHitRate([deepseek])).toBe(true);
    expect(canShowCacheHitRate([])).toBe(false);
    expect(canShowCacheHitRate(undefined)).toBe(false);
  });

  it('耗时列（§13.3，评审 P9）：毫秒/秒分档', () => {
    expect(formatLatency(340)).toBe('340ms');
    expect(formatLatency(2340)).toBe('2.3s');
    expect(formatLatency(-1)).toBe('—');
  });

  it('tokens 千位缩写', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
  });
});
