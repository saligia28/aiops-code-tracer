/**
 * L3 judge · 确定性部分单测（不调 LLM，CI 无条件可跑）。
 * LLM-judge 本体的验证走 `pnpm --filter @aiops/api eval -- answers`（需服务 + LLM）。
 */
import { describe, it, expect } from 'vitest';
import { checkMentions, checkHallucinations, parseJudgeJson, aggregateVotes, type JudgeVerdict } from './judge.ts';

describe('L3 · 确定性子检查', () => {
  it('mustMention：大小写不敏感，缺失逐一列出', () => {
    const r = checkMentions('答案在 src/views/stockCheck/List.vue 里', ['stockcheck', 'BandPlaning']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['BandPlaning']);
  });

  it('幻觉陷阱：出现禁提词即命中', () => {
    const r = checkHallucinations('可能是 stockOrder 下的页面', ['stockOrder']);
    expect(r.ok).toBe(false);
    expect(r.hits).toEqual(['stockOrder']);
  });
});

describe('L3 · judge JSON 稳健解析', () => {
  it('容忍 markdown 围栏与前后杂文', () => {
    const v = parseJudgeJson('评审如下：\n```json\n{"faithful":true,"correct":null,"codeFirst":null,"score":8,"reasons":{"faithful":"均有证据"}}\n```\n以上。');
    expect(v).toMatchObject({ faithful: true, correct: null, score: 8 });
  });

  it('缺 faithful 字段 → null（不猜）', () => {
    expect(parseJudgeJson('{"score": 9}')).toBeNull();
  });

  it('score 越界收敛到 [0,10]', () => {
    const v = parseJudgeJson('{"faithful":false,"score":99,"reasons":{"faithful":"x"}}');
    expect(v?.score).toBe(10);
  });

  it('basis 枚举映射 codeFirst：code→true，doc/mixed→false，n/a→null（防布尔极性翻转）', () => {
    expect(parseJudgeJson('{"faithful":true,"basis":"code","score":8,"reasons":{"faithful":"x"}}')?.codeFirst).toBe(true);
    expect(parseJudgeJson('{"faithful":true,"basis":"doc","score":3,"reasons":{"faithful":"x"}}')?.codeFirst).toBe(false);
    expect(parseJudgeJson('{"faithful":true,"basis":"mixed","score":5,"reasons":{"faithful":"x"}}')?.codeFirst).toBe(false);
    expect(parseJudgeJson('{"faithful":true,"basis":"n/a","score":8,"reasons":{"faithful":"x"}}')?.codeFirst).toBeNull();
  });
});

describe('L3 · 多数票聚合', () => {
  const mk = (faithful: boolean, score: number, codeFirst: boolean | null = null): JudgeVerdict => ({
    faithful, correct: null, codeFirst, score, reasons: { faithful: '' },
  });

  it('布尔取多数，score 取中位', () => {
    const v = aggregateVotes([mk(true, 8), mk(true, 9), mk(false, 2)]);
    expect(v.faithful).toBe(true);
    expect(v.score).toBe(8);
  });

  it('codeFirst 全 null 保持 null；混票取非 null 多数', () => {
    expect(aggregateVotes([mk(true, 5), mk(true, 5)]).codeFirst).toBeNull();
    expect(aggregateVotes([mk(true, 5, true), mk(true, 5, true), mk(true, 5, null)]).codeFirst).toBe(true);
  });
});
