/**
 * 文档证据通道：markdown 分块（chunkMarkdown）单测。
 *
 * chunkMarkdown 是纯函数（不触网、不读盘），负责把一篇 markdown 切成带
 * title / section / terms 的文档块草稿；向量化与 idf 由 buildDocIndex 负责。
 *
 * 运行：pnpm --filter @aiops/api test
 */
import { test, expect } from 'vitest';
import { chunkMarkdown } from '../src/services/ask/indexing.ts';

test('按标题切分：H1 作 title，各 H2 成独立块，source 透传', () => {
  const md = [
    '# 订单模块设计',
    '',
    '前言段落，说明背景。',
    '',
    '## 作废规则',
    '订单在已审核状态下不可作废。',
    '',
    '## 分页约定',
    '默认每页 20 条。',
  ].join('\n');

  const chunks = chunkMarkdown(md, 'order/design.md');

  expect(chunks.length).toBe(3);
  expect(chunks.map((c) => c.section)).toEqual(['订单模块设计', '作废规则', '分页约定']);
  expect(chunks.every((c) => c.title === '订单模块设计')).toBe(true);
  expect(chunks.every((c) => c.source === 'order/design.md')).toBe(true);
  expect(chunks[1].text).toContain('作废');
  // id 必须唯一
  expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
});

test('超长章节按段落拆成多块，每块不超过上限', () => {
  const longBody = Array.from({ length: 60 }, (_, i) => `第${i}段：这是一段足够长的中文说明文字用来撑大体积。`).join('\n\n');
  const md = `## 长章节\n\n${longBody}`;

  const chunks = chunkMarkdown(md, 'big.md');
  const sectionChunks = chunks.filter((c) => c.section === '长章节');

  expect(sectionChunks.length).toBeGreaterThan(1);
  expect(sectionChunks.every((c) => c.text.length <= 800)).toBe(true);
});

test('无 H1 时 title 回退到文件名；terms 非空且小写', () => {
  const md = '没有标题的内容。\n\n## 小节\n正文。';
  const chunks = chunkMarkdown(md, 'docs/无标题.markdown');

  expect(chunks[0].title).toBe('无标题');
  expect(chunks.every((c) => c.terms.length > 0)).toBe(true);
  expect(chunks.every((c) => c.terms.every((t) => t === t.toLowerCase()))).toBe(true);
});

test('空文档返回空数组', () => {
  expect(chunkMarkdown('', 'empty.md')).toEqual([]);
  expect(chunkMarkdown('   \n\n  \n', 'blank.md')).toEqual([]);
});
