/**
 * Agent 证据收集层单测（T1）—— 「模型看过的行」能否被无损还原成 Evidence。
 *
 * 刻意用**真实工具输出**而非手写字符串喂解析器：格式一旦在 tools.ts 改动，
 * 这里立刻红，而不是等线上 evidence 悄悄变空、L1 静默跳过。
 * 断言口径按 T1 验收：Evidence 的 file/line/code 与源码**逐字**匹配。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/agent/tools.ts';
import { indexToolObservations, collectAgentEvidence } from '../src/agent/evidenceCollector.ts';

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

  it('答案引用了没看过的行 → 降级为 (见 file:line)，而不是丢掉这条引用', () => {
    const evidence = collectAgentEvidence(`见 ${TARGET}:999 的实现`, new Map());
    expect(evidence).toHaveLength(1);
    expect(evidence[0].code).toBe(`(见 ${TARGET}:999)`);
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
