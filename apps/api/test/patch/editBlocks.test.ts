/**
 * SEARCH/REPLACE 编辑块解析 + 应用（P2-G1 方案 B 的 LLM 契约）。
 * 解析容忍散文/围栏；应用要求唯一精确匹配，找不到/多处匹配都给可反馈原因。
 */
import { describe, it, expect } from 'vitest';
import {
  parseEditBlocks,
  applyEditsToFile,
  groupEditsByFile,
} from '../../src/services/patch/editBlocks.js';

const block = (file: string | null, search: string, replace: string): string =>
  [
    `<<<<<<< SEARCH${file ? ` file=${file}` : ''}`,
    search,
    '=======',
    replace,
    '>>>>>>> REPLACE',
  ].join('\n');

describe('parseEditBlocks', () => {
  it('解析带 file= 的单块', () => {
    const blocks = parseEditBlocks(block('src/api/orderVoid.ts', '  if (!id) return', "  if (!id) throw new Error('x')"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].file).toBe('src/api/orderVoid.ts');
    expect(blocks[0].search).toBe('  if (!id) return');
    expect(blocks[0].replace).toBe("  if (!id) throw new Error('x')");
  });

  it('解析无 file= 的块（file 为 undefined）', () => {
    const blocks = parseEditBlocks(block(null, 'a', 'b'));
    expect(blocks[0].file).toBeUndefined();
  });

  it('容忍块外散文与代码围栏', () => {
    const text = ['这是我的修改：', '```', block('x.ts', 'foo', 'bar'), '```', '完成。'].join('\n');
    const blocks = parseEditBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('foo');
  });

  it('解析多块', () => {
    const text = block('a.ts', 'a1', 'A1') + '\n\n' + block('b.ts', 'b1', 'B1');
    expect(parseEditBlocks(text)).toHaveLength(2);
  });

  it('多行 SEARCH/REPLACE', () => {
    const blocks = parseEditBlocks(block('x.ts', 'line1\nline2', 'lineA\nlineB\nlineC'));
    expect(blocks[0].search).toBe('line1\nline2');
    expect(blocks[0].replace).toBe('lineA\nlineB\nlineC');
  });
});

describe('applyEditsToFile', () => {
  const original = "export async function voidOrder(id) {\n  if (!id) return\n  return post({ id })\n}\n";

  it('唯一精确匹配 → 替换', () => {
    const r = applyEditsToFile(original, [{ search: '  if (!id) return', replace: "  if (!id) throw new Error('x')" }]);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("throw new Error('x')");
    expect(r.content).not.toContain('if (!id) return');
  });

  it('SEARCH 未找到 → 报错', () => {
    const r = applyEditsToFile(original, [{ search: '  if (!nonexistent) return', replace: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未在当前内容找到');
  });

  it('SEARCH 多处匹配 → 报错（需更多上下文）', () => {
    const dup = 'x\nx\n';
    const r = applyEditsToFile(dup, [{ search: 'x', replace: 'y' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('多处匹配');
  });

  it('空 SEARCH → 报错', () => {
    const r = applyEditsToFile(original, [{ search: '', replace: 'x' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('为空');
  });

  it('多个编辑顺序应用', () => {
    const r = applyEditsToFile('a\nb\nc\n', [
      { search: 'a', replace: 'A' },
      { search: 'c', replace: 'C' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('A\nb\nC\n');
  });
});

describe('groupEditsByFile', () => {
  it('按 file 归组，无 file 用默认', () => {
    const g = groupEditsByFile(
      [
        { file: 'a.ts', search: 's', replace: 'r' },
        { search: 's2', replace: 'r2' },
        { file: 'a.ts', search: 's3', replace: 'r3' },
      ],
      'default.ts',
    );
    expect(g.get('a.ts')).toHaveLength(2);
    expect(g.get('default.ts')).toHaveLength(1);
  });
});
