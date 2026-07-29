/**
 * L1 反馈文案按管线分化（T20）。
 *
 * 背景是一次活体退化：agent 重答收到"无法确认就别写行号"后，把**全部行号删光**
 * （4633 字答案里 file:line 归零）。因为 agent 重答时禁用工具、早期读文件结果已被折叠，
 * 它没有能力把行号改对——删除是唯一能执行的合规动作。
 * 所以这套断言盯的不是"文案好不好看"，而是**降级路径存不存在**：
 * 只要"保留引用"比"删除引用"更容易执行，模型就不会再走极端。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { Evidence } from '@aiops/shared-types';
import { reflectOnAnswer } from '../src/services/ask/reflection.ts';

const REPO = path.join(os.tmpdir(), `aiops-reflect-fb-${crypto.randomUUID()}`);
const FILE = 'src/foo.ts';

beforeAll(() => {
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO, FILE), ['const a = 1', 'const b = 2', 'const c = 3'].join('\n'));
});

/** 一条越界引用 → L1 必然不通过（accuracy 0 < 阈值 0.8） */
const badEvidence: Evidence[] = [{ file: FILE, line: 999, code: 'doSomething()', label: '关键代码' }];

async function feedbackFor(pipeline?: 'ask' | 'agent'): Promise<string> {
  const r = await reflectOnAnswer({
    question: '这段逻辑在哪',
    answer: `见 ${FILE}:999`,
    evidence: badEvidence,
    repoPath: REPO,
    ...(pipeline ? { pipeline } : {}),
  });
  expect(r.pass).toBe(false);
  expect(r.feedback).toBeTruthy();
  return r.feedback!;
}

describe('T20 · L1 反馈按管线分化', () => {
  it('agent：首句先关掉工具意图（否则重答会吐工具调用标记当正文）', async () => {
    const fb = await feedbackFor('agent');
    // 实测：缺这句时 DeepSeek 有 5/6 次把 DSML 工具调用标记当答案吐出来——
    // tools 传空数组只让 API 不返回结构化 tool_call，system prompt 里的工具目录还在。
    // forceFinalAnswer 一直有这句，反思重答原先没有，是 T1 留下的不一致。
    expect(fb).toContain('不要再调用任何工具');
    expect(fb.indexOf('不要再调用任何工具')).toBeLessThan(fb.indexOf('引用纪律'));
  });

  it('agent：明令保留文件引用，并给出「未确认行号」这条降级路径', async () => {
    const fb = await feedbackFor('agent');

    // ① 禁止删除——这正是活体里模型选择的那条路
    expect(fb).toContain('保留原有的文件引用');
    expect(fb).toMatch(/不要因为行号存疑就删掉整条引用/);
    // ② 有降级出口：删不掉行号时写成「文件名（未确认行号）」，文件名必须留着
    expect(fb).toContain('未确认行号');
    expect(fb).toContain('文件名必须留着');
    // ③ 核对通过的引用别动（不然模型会顺手把好的一起删）
    expect(fb).toMatch(/没有被列出的引用是核对通过的/);
    // ④ 仍然禁止编造——降级不能变成"猜一个看起来合理的数字"
    expect(fb).toMatch(/不要新增你没有实际读到过的行号/);
  });

  it('ask：措辞保持原样（codeContext 在眼前，模型能直接改对，不需要降级路径）', async () => {
    const fb = await feedbackFor('ask');
    expect(fb).toContain('只引用「相关代码」里真实出现的 文件:行号');
    expect(fb).toContain('无法确认的位置不要编造行号');
    // ask 侧不该混进 agent 的降级话术（否则会诱导它保留其实能改对的错行号）
    expect(fb).not.toContain('未确认行号');
  });

  it('缺省即 ask —— 老调用方（routes/ask.ts）行为逐字不变', async () => {
    expect(await feedbackFor()).toBe(await feedbackFor('ask'));
  });

  it('两套文案都列出具体的不实引用（file:line + 原因），否则模型不知道改哪条', async () => {
    for (const p of ['ask', 'agent'] as const) {
      const fb = await feedbackFor(p);
      expect(fb).toContain(`${FILE}:999`);
      expect(fb).toContain('行号越界');
    }
  });
});
