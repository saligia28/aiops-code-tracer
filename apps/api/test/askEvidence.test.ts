/**
 * ask 侧证据提取回归 —— 与 agent 侧（agentEvidence.test.ts「L1 误报回归」）同款两个根因：
 *   ① 排除式字符类把 markdown 加粗 / 全角括号连同黏连中文一起吃进文件名；
 *   ② `(见 file:line)` 占位含路径段，被 citationAccuracy 当"声称的标识符"误核。
 * extractEvidenceFromAnswer 与 collectAgentEvidence 是两份实现（code 来源不同），
 * 语义约定必须两边同步验证，否则只修 agent 侧，ask 流水线照样触发误报重答。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractEvidenceFromAnswer } from '../src/services/ask/answer.ts';
import { citationAccuracy } from '../src/services/citationCheck.ts';

describe('L1 误报回归 · extractEvidenceFromAnswer', () => {
  it('markdown 加粗 / 全角括号黏连 → 路径剥净', () => {
    const answer = '入口在 **src/api/order.ts:3**，另见（src/utils/format.vue:5）的实现。';
    const evidence = extractEvidenceFromAnswer(answer, '');
    expect(evidence.map((e) => `${e.file}:${e.line}`)).toEqual([
      'src/api/order.ts:3',
      'src/utils/format.vue:5',
    ]);
  });

  it('codeContext 里没有的行 → 占位不含 ASCII 标识符（路径段也不行）', () => {
    const evidence = extractEvidenceFromAnswer('见 src/pay/refund.ts:1。', '');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].code).not.toMatch(/[A-Za-z_$][\w$]{2,}/);
  });

  it('占位证据过 citationAccuracy → 宽松核对（行存在即匹配），不再误判', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-evidence-'));
    try {
      fs.mkdirSync(path.join(repo, 'src/pay'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src/pay/refund.ts'),
        ['export const limit = 20;', 'export const flag = true;'].join('\n'),
      );
      const evidence = extractEvidenceFromAnswer('扣减逻辑在 src/pay/refund.ts:1。', '');
      const r = citationAccuracy(evidence, repo);
      expect(r.checks[0]).toMatchObject({ fileExists: true, lineExists: true, matched: true });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
