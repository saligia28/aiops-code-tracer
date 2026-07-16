import { describe, it, expect } from 'vitest';
import type { Evidence } from '@aiops/shared-types';
import { buildEvidenceHints, buildEvidenceContext } from '../src/services/ask/answer.js';
import { estimateTokens } from '../src/services/ask/textUtils.js';

// 测试环境未加载仓库（currentRepoPath 为空），getCodeSnippet 恒返回占位文案，
// 单条成本由 label 长度主导——用 ASCII label 精确控制 token（estimateTokens：ASCII len/4）。
function ev(label: string, file = 'src/a.ts', line = 10): Evidence {
  return { file, line, code: '', label };
}

describe('evidence 贪心装填（P2-H）', () => {
  it('无条数硬截断：预算充足时 10 条全装（旧实现 hints 截 8 / context 截 6）', () => {
    const items = Array.from({ length: 10 }, (_, i) => ev(`label-${i}`, `src/f${i}.ts`, i + 1));
    const hints = buildEvidenceHints(items, '', 1_000_000);
    expect(hints).toContain('10. [label-9]');
    const ctx = buildEvidenceContext(items, 1_000_000);
    expect(ctx).toContain('10. src/f9.ts:10');
  });

  it('装不下的跳过并继续：大条目后面的小条目不再被"首超即停"误伤', () => {
    const small1 = ev('s'.repeat(100), 'src/s1.ts'); // ~30 token
    const big = ev('X'.repeat(4000), 'src/big.ts'); // ~1000 token，装不下
    const small2 = ev('t'.repeat(100), 'src/s2.ts'); // ~30 token
    const hints = buildEvidenceHints([small1, big, small2], '', 150);
    expect(hints).toContain('src/s1.ts');
    expect(hints).not.toContain('src/big.ts');
    // 旧实现：big 超预算即 break，small2 被连带丢弃
    expect(hints).toContain('src/s2.ts');

    const ctx = buildEvidenceContext([small1, big, small2], 150);
    expect(ctx).toContain('src/s1.ts');
    expect(ctx).not.toContain('src/big.ts');
    expect(ctx).toContain('src/s2.ts');
  });

  it('预算真实生效：产出总 token 不超预算（放宽换行分隔符的零头）', () => {
    const items = Array.from({ length: 20 }, (_, i) => ev('y'.repeat(200), `src/g${i}.ts`, i + 1));
    const budget = 300;
    const hints = buildEvidenceHints(items, '', budget);
    expect(estimateTokens(hints)).toBeLessThanOrEqual(budget + items.length);
  });

  it('已在代码片段中的条目只占一行（不重复贴 snippet）', () => {
    const codeContext = '--- src/a.ts ---\nL10: const x = 1';
    const hints = buildEvidenceHints([ev('关键条件', 'src/a.ts', 10)], codeContext, 1000);
    expect(hints).toContain('（已在代码片段中）');
  });

  it('空证据与预算过小的边界：返回「无」', () => {
    expect(buildEvidenceHints([], '', 1000)).toBe('无');
    expect(buildEvidenceContext([], 1000)).toBe('无');
    // 预算小到一条都装不下
    expect(buildEvidenceHints([ev('Z'.repeat(400))], '', 10)).toBe('无');
    expect(buildEvidenceContext([ev('Z'.repeat(400))], 10)).toBe('无');
  });

  it('编号随装填顺序连续（跳过条目不留空号）', () => {
    const big = ev('X'.repeat(4000), 'src/big.ts');
    const small1 = ev('a'.repeat(40), 'src/s1.ts');
    const small2 = ev('b'.repeat(40), 'src/s2.ts');
    const hints = buildEvidenceHints([small1, big, small2], '', 60);
    const numbers = [...hints.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2]);
  });
});
