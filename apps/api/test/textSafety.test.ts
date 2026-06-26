/**
 * 回归测试：发往严格 LLM JSON 解析器（如 DeepSeek）的文本必须是合法 UTF-16。
 *
 * Bug 背景：list_directory 工具结果含 📁/📄（emoji=代理对）。tools.ts 的 truncate() 按字符截断
 * 时会把代理对劈成两半，留下落单代理项；DeepSeek 报 400
 * "unexpected end of hex escape: messages[N].content"。详见 sanitizeMessageText / truncate 注释。
 *
 * 运行：pnpm --filter @aiops/api test
 */
import { test, expect } from 'vitest';
import { sanitizeMessageText } from '../src/agent/llmWithTools.ts';
import { truncate } from '../src/agent/tools.ts';
import { stripLoneSurrogates } from '../src/textSafety.ts';

const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

// 复刻真实工具结果形态：满是 📁/📄 的目录树
const dirTree = Array.from({ length: 200 }, (_, i) => `📁 dir${i}\n  📄 File${i}.java`).join('\n');

test('truncate 不会把代理对从中间切断（源头防御）', () => {
  for (let limit = 30; limit < 160; limit++) {
    expect(!hasLoneSurrogate(truncate(dirTree, limit)), `truncate@${limit} 产生了落单代理项`).toBe(true);
  }
});

test('sanitizeMessageText 清除落单代理项（边界兜底）', () => {
  // 即便上游用裸 slice 把代理对劈断，边界兜底也必须救回
  for (let limit = 30; limit < 160; limit++) {
    const safe = sanitizeMessageText(dirTree.slice(0, limit)) as string;
    expect(!hasLoneSurrogate(safe), `limit=${limit} 仍含落单代理项`).toBe(true);
  }
  const broken = 'abc\uD83Ddef'; // 落单高位代理
  expect(hasLoneSurrogate(broken)).toBe(true);
  expect(!hasLoneSurrogate(sanitizeMessageText(broken) as string)).toBe(true);
});

test('成对 emoji / 中文 / 普通文本不被改动', () => {
  expect(sanitizeMessageText('📁📄 中文 abc \\u4e00 path\\to')).toBe('📁📄 中文 abc \\u4e00 path\\to');
});

test('stripLoneSurrogates（agent 与 RAG 共用的底层工具）', () => {
  // 高位/低位落单代理都要被清掉；成对的不动
  expect(!hasLoneSurrogate(stripLoneSurrogates('x\uD83Dy'))).toBe(true);
  expect(!hasLoneSurrogate(stripLoneSurrogates('x\uDCC1y'))).toBe(true);
  expect(stripLoneSurrogates('📁📄 中文 abc')).toBe('📁📄 中文 abc');
  // RAG 兜底场景：按字符 slice 代码上下文后必须合法
  const ctx = Array.from({ length: 100 }, (_, i) => `--- f${i}.ts ---\nconst x${i} = '📄';`).join('\n');
  for (let n = 20; n < 120; n++) expect(!hasLoneSurrogate(stripLoneSurrogates(ctx.slice(0, n)))).toBe(true);
});

test('null / undefined / 空串原样返回', () => {
  expect(sanitizeMessageText(null)).toBe(null);
  expect(sanitizeMessageText(undefined)).toBe(undefined);
  expect(sanitizeMessageText('')).toBe('');
});
