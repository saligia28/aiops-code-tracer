/**
 * Agent 证据收集层单测（T1）—— 「模型看过的行」能否被无损还原成 Evidence。
 *
 * 刻意用**真实工具输出**而非手写字符串喂解析器：格式一旦在 tools.ts 改动，
 * 这里立刻红，而不是等线上 evidence 悄悄变空、L1 静默跳过。
 * 断言口径按 T1 验收：Evidence 的 file/line/code 与源码**逐字**匹配。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/agent/tools.ts';
import { indexToolObservations, collectAgentEvidence } from '../src/agent/evidenceCollector.ts';
import { citationAccuracy } from '../src/services/citationCheck.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, 'eval/fixture-repo');
const TARGET = 'src/api/orderVoid.ts';

function sourceLines(rel: string): string[] {
  return fs.readFileSync(path.join(REPO, rel), 'utf-8').split('\n');
}

describe('T1 · indexToolObservations 还原「模型看过哪些行」', () => {
  it('read_file：每一行的文本与源码逐字一致（trim 后）', async () => {
    const result = await executeTool('read_file', { filePath: TARGET }, null, REPO);
    const index = indexToolObservations([{ toolName: 'read_file', args: { filePath: TARGET }, result }]);

    const fileMap = index.get(TARGET);
    expect(fileMap, '目标文件没进索引——头部文件名解析可能挂了').toBeDefined();

    const lines = sourceLines(TARGET);
    // 逐行核对（跳过空行：工具输出保留空行但索引里存的是 trim 后的空串）
    let checked = 0;
    for (const [lineNo, text] of fileMap!) {
      expect(lineNo).toBeGreaterThanOrEqual(1);
      expect(lineNo).toBeLessThanOrEqual(lines.length);
      expect(text).toBe(lines[lineNo - 1].trim());
      checked++;
    }
    expect(checked).toBe(lines.length);
  });

  it('search_in_file：命中行（> 前缀）与上下文行都能解析出正确行号与文本', async () => {
    const args = { filePath: TARGET, pattern: 'voidOrder' };
    const result = await executeTool('search_in_file', args, null, REPO);
    const index = indexToolObservations([{ toolName: 'search_in_file', args, result }]);

    const fileMap = index.get(TARGET);
    expect(fileMap).toBeDefined();
    expect(fileMap!.size).toBeGreaterThan(0);

    const lines = sourceLines(TARGET);
    for (const [lineNo, text] of fileMap!) {
      expect(text).toBe(lines[lineNo - 1].trim());
    }
    // 命中行本身必须在索引里
    const hitLine = lines.findIndex((l) => l.includes('voidOrder')) + 1;
    expect(fileMap!.has(hitLine)).toBe(true);
  });

  it('search_code：rg/grep 的 path:line:text 三段式能解析（含 ./ 前缀归一）', async () => {
    const args = { pattern: 'axios' };
    const result = await executeTool('search_code', args, null, REPO);
    const index = indexToolObservations([{ toolName: 'search_code', args, result }]);

    // 至少命中一个源码文件，且行号对应的源码行确实包含 axios
    expect(index.size).toBeGreaterThan(0);
    for (const [file, fileMap] of index) {
      expect(file.startsWith('./'), 'path 应已归一化去掉 ./ 前缀').toBe(false);
      const lines = sourceLines(file);
      for (const [lineNo, text] of fileMap) {
        expect(lines[lineNo - 1]).toContain(text);
      }
    }
  });

  it('非源码后缀不进索引（避免把 md/json 里的 path:line 噪声当证据）', () => {
    const index = indexToolObservations([
      { toolName: 'search_code', args: {}, result: 'README.md:3:安装说明\nsrc/a.ts:5:const a = 1' },
    ]);
    expect(index.has('README.md')).toBe(false);
    expect(index.get('src/a.ts')?.get(5)).toBe('const a = 1');
  });
});

describe('T1 · collectAgentEvidence 从答案里抽引用', () => {
  it('答案引用了看过的行 → code 就是模型看到的那行原文', async () => {
    const result = await executeTool('read_file', { filePath: TARGET }, null, REPO);
    const index = indexToolObservations([{ toolName: 'read_file', args: { filePath: TARGET }, result }]);

    const lines = sourceLines(TARGET);
    const voidLine = lines.findIndex((l) => l.includes('export function voidOrder')) + 1;
    const answer = `结论：作废走 ${TARGET}:${voidLine} 的 voidOrder。`;

    const evidence = collectAgentEvidence(answer, index);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].file).toBe(TARGET);
    expect(evidence[0].line).toBe(voidLine);
    expect(evidence[0].code).toBe(lines[voidLine - 1].trim());
  });

  it('答案引用了没看过的行 → 降级为无标识符占位，而不是丢掉这条引用', () => {
    const evidence = collectAgentEvidence(`见 ${TARGET}:999 的实现`, new Map());
    expect(evidence).toHaveLength(1);
    // 占位文案不得含 ASCII 标识符（路径段也不行）——否则 citationAccuracy 会把
    // 路径段当"声称的标识符"去 ±2 行窗口里找，核对结果近乎随机（误报根因之一）
    expect(evidence[0].code).not.toMatch(/[A-Za-z_$][\w$]{2,}/);
  });

  it('去重 + 上限 12 条 + 忽略非源码引用', () => {
    const refs = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts:${i + 1}`).join('、');
    const answer = `${refs}、重复 src/f0.ts:1、文档 docs/readme.md:3`;
    const evidence = collectAgentEvidence(answer, new Map());
    expect(evidence).toHaveLength(12);
    expect(evidence.filter((e) => e.file === 'src/f0.ts')).toHaveLength(1);
    expect(evidence.some((e) => e.file.endsWith('.md'))).toBe(false);
  });

  it('空答案 / 无引用 → 空数组（L1 会因此跳过，属预期降级而非错误）', () => {
    expect(collectAgentEvidence('', new Map())).toEqual([]);
    expect(collectAgentEvidence('结论：没有定位到相关实现。', new Map())).toEqual([]);
  });
});

/**
 * L1 误报回归——「未确认行号」大面积出现的两个根因：
 *   ① 中文答案里 markdown 加粗 / 全角括号会与路径黏连（中文不打空格），
 *      排除式字符类把 `**` / `另见（` 一并吃进文件名 → fileExists=false → 误判编造；
 *   ② `(见 file:line)` 占位含路径段（src/api/…），被 extractIdentifiers 当成
 *      "声称的标识符"拿去 ±2 行窗口比对 → 正确引用也近乎随机地判失败。
 * 两者都会把 citationAccuracy 拉到阈值以下，触发反思重答；重答阶段无工具、
 * 上下文已折叠，模型只能按纪律降级成「文件名（未确认行号）」。
 */
describe('L1 误报回归 · 引用提取与降级占位', () => {
  it('markdown 加粗包住的引用 → 路径不带 ** 污染', () => {
    const evidence = collectAgentEvidence('入口在 **src/api/order.ts:3** 这一行。', new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0].file).toBe('src/api/order.ts');
    expect(evidence[0].line).toBe(3);
  });

  it('全角括号且与中文黏连 → 只取路径本体', () => {
    const evidence = collectAgentEvidence('另见（src/utils/format.ts:5）的实现。', new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0].file).toBe('src/utils/format.ts');
    expect(evidence[0].line).toBe(5);
  });

  it('没被行索引覆盖的真实引用 → citationAccuracy 走宽松核对，不再误判', () => {
    // hermetic fixture：内容刻意不含路径段（src/pay/refund）的任何子串，
    // 旧占位 `(见 src/pay/refund.ts:1)` 会因此在窗口里找不到"标识符"而误判失败
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-evidence-'));
    try {
      fs.mkdirSync(path.join(repo, 'src/pay'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src/pay/refund.ts'),
        ['export const limit = 20;', 'export const flag = true;'].join('\n'),
      );
      const evidence = collectAgentEvidence('扣减逻辑在 src/pay/refund.ts:1。', new Map());
      const r = citationAccuracy(evidence, repo);
      expect(r.checks[0]).toMatchObject({ fileExists: true, lineExists: true, matched: true });
      expect(r.accuracy).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
