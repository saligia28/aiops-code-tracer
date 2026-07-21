/**
 * propose_patch 编排（P2-G1）。mock LLM 驱动全部分支，完全离线确定性：
 * 成功 / 重试后成功（含反馈回塞验证）/ 放弃 / LLM 不可用 / 越界文件 / 无变化 / 非法入参。
 * 并断言成功路径全过程仓库文件字节不变（端到端的"未审批绝不写盘"）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proposePatch, type ProposeDeps } from '../../src/services/patch/proposePatch.js';

let repo: string;
const REL = 'src/api/orderVoid.ts';
const ORIGINAL = [
  'export async function voidOrder(id) {',
  '  if (!id) return',
  "  return request.post('/order/void', { id })",
  '}',
  '',
].join('\n');

const srBlock = (file: string | null, search: string, replace: string): string =>
  [`<<<<<<< SEARCH${file ? ` file=${file}` : ''}`, search, '=======', replace, '>>>>>>> REPLACE'].join('\n');

const GOOD = srBlock(REL, '  if (!id) return', "  if (!id) throw new Error('missing id')");
const BAD_SEARCH = srBlock(REL, '  if (!NOPE) return', '  whatever');

/** 队列式假 LLM：按序返回预设响应，超出则重复最后一条；记录每次收到的 messages。 */
function fakeLlm(responses: Array<string | null>) {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  let i = 0;
  const fn = async (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) => {
    calls.push(messages);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { fn, calls };
}

function deps(llm: ProposeDeps['llm'], maxAttempts = 2): ProposeDeps {
  return { llm, now: () => '2026-07-21T00:00:00.000Z', newId: () => 'test-proposal-id', maxAttempts };
}

const input = (files = [REL]) => ({ question: '空 id 应抛错而非静默返回', files, repoName: 'fixture' });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, REL), ORIGINAL);
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('proposePatch', () => {
  it('成功路径：LLM 出合法编辑 → 提案通过 gate、盖 validatedAt、仓库零改动', async () => {
    const before = fs.readFileSync(path.join(repo, REL));
    const { fn } = fakeLlm([GOOD]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.validatedAt).toBe('2026-07-21T00:00:00.000Z');
    expect(r.proposal.files[0].file).toBe(REL);
    expect(r.proposal.files[0].baselineSha256).toHaveLength(64);
    expect(r.proposal.unifiedDiff).toContain('+  if (!id) throw new Error');
    // 端到端"未审批绝不写盘"：全过程仓库文件字节不变
    expect(fs.readFileSync(path.join(repo, REL)).equals(before)).toBe(true);
  });

  it('重试后成功：首轮 SEARCH 打不上 → 反馈回塞 → 次轮修好', async () => {
    const { fn, calls } = fakeLlm([BAD_SEARCH, GOOD]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    // 第二次调用的 user 轮应带上一轮失败反馈
    const secondUser = calls[1].find((m) => m.role === 'user')!.content;
    expect(secondUser).toContain('上一轮补丁的问题');
    expect(secondUser).toContain('无法定位');
  });

  it('放弃：始终打不上 → PATCH_NOT_APPLICABLE（attempts 到顶）', async () => {
    const { fn } = fakeLlm([BAD_SEARCH]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PATCH_NOT_APPLICABLE');
    expect(r.attempts).toBe(2);
  });

  it('LLM 不可用（返回 null）→ LLM_UNAVAILABLE', async () => {
    const { fn } = fakeLlm([null]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('LLM_UNAVAILABLE');
  });

  it('越界文件：编辑指向未声明文件 → 放弃并说明', async () => {
    const stray = srBlock('src/api/other.ts', 'a', 'b');
    const { fn } = fakeLlm([stray]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PATCH_NOT_APPLICABLE');
    expect(r.detail).toContain('未声明文件');
  });

  it('无变化：SEARCH 与 REPLACE 相同 → NO_CHANGE', async () => {
    const noop = srBlock(REL, '  if (!id) return', '  if (!id) return');
    const { fn } = fakeLlm([noop]);
    const r = await proposePatch(input(), repo, deps(fn));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_CHANGE');
  });

  it('非法入参：路径不安全（..）→ INVALID_INPUT，不调用 LLM', async () => {
    const { fn, calls } = fakeLlm([GOOD]);
    const r = await proposePatch(input(['../evil.ts']), repo, deps(fn));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });
});
