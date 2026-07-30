/**
 * 反思 L2 judge 的成本追踪（交付评审 P2 的回归）。
 *
 * 背景：REFLECT_JUDGE=1 时 reflectOnAnswer 会真调一次 LLM（judgeAnswer 1 票），
 * 修复前这次调用不接 usage 上下文——开着反思裁决跑一天，账本上一条都看不到。
 * 这里只盯「usage 有没有透传到 judgeAnswer」；judge 内部拿到 usage 后怎么记账，
 * 由 answerJudge/adapter 侧用例覆盖，不在此重复。
 *
 * REFLECT_JUDGE 在模块加载时读取，所以必须先设 env 再动态 import（与 usageAdapter 同款套路）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmUsageContext } from '../src/services/usage/usageTracker.ts';

process.env.REFLECT_JUDGE = '1';

vi.mock('../src/services/answerJudge.js', () => ({
  judgeAnswer: vi.fn(async () => ({
    verdict: { faithful: true, grounded: true, reasons: { faithful: '', grounded: '' } },
    votes: [],
  })),
}));

const { judgeAnswer } = await import('../src/services/answerJudge.js');
const { reflectOnAnswer } = await import('../src/services/ask/reflection.ts');

// evidence 空 + repoPath 空 → L1 引用核对整段跳过，直达 L2 judge
const INPUT = { question: '订单作废在哪实现？', answer: '见 orderVoid.ts。', evidence: [], repoPath: '' };

beforeEach(() => vi.mocked(judgeAnswer).mockClear());

describe('reflectOnAnswer · L2 judge 记账（P2）', () => {
  it('usage 上下文原样透传给 judgeAnswer，且固定 1 票', async () => {
    const usage = { tracker: {}, stage: 'ask.reflection' } as unknown as LlmUsageContext;
    const r = await reflectOnAnswer({ ...INPUT, usage });

    expect(r.pass).toBe(true);
    expect(judgeAnswer).toHaveBeenCalledTimes(1);
    const [, votes, passedUsage] = vi.mocked(judgeAnswer).mock.calls[0];
    expect(votes).toBe(1);
    expect(passedUsage).toBe(usage);
  });

  it('不传 usage 时 judge 收到 undefined（judge 侧按"不记账"处理，行为与修复前一致）', async () => {
    await reflectOnAnswer(INPUT);

    expect(judgeAnswer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(judgeAnswer).mock.calls[0][2]).toBeUndefined();
  });
});
