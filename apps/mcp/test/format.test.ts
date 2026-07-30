import { describe, it, expect } from 'vitest';
import type { AskResponse, GraphNode, GraphEdge } from '@aiops/shared-types';
import { formatNode, formatGraph, formatSearch, formatRepoStatus, formatAskResponse, clampText } from '../src/format.js';

const login: GraphNode = { id: 'function:src/user.ts:login', type: 'function', name: 'login', filePath: 'src/user.ts', loc: '88:2' };
const issue: GraphNode = { id: 'function:src/token.ts:issue', type: 'function', name: 'issue', filePath: 'src/token.ts', loc: '20:2' };
const edge: GraphEdge = { from: login.id, to: issue.id, type: 'calls', meta: { confidence: 'high' } };

describe('format', () => {
  it('formatNode renders name (type) — file:loc', () => {
    expect(formatNode(login)).toBe('login (function) — src/user.ts:88:2');
  });

  it('formatNode includes meta.kind when present', () => {
    const m: GraphNode = { ...login, type: 'function', meta: { kind: 'method' } };
    expect(formatNode(m)).toBe('login (function/method) — src/user.ts:88:2');
  });

  it('formatGraph resolves edge endpoints to names', () => {
    const out = formatGraph([login, issue], [edge]);
    expect(out).toContain('login --calls--> issue');
    expect(out).toContain('• login (function) — src/user.ts:88:2');
  });

  it('formatGraph marks non-high confidence', () => {
    const low: GraphEdge = { ...edge, meta: { confidence: 'low' } };
    expect(formatGraph([login, issue], [low])).toContain('--calls--> issue [low]');
  });

  it('formatGraph handles empty', () => {
    expect(formatGraph([], [])).toBe('（无结果）');
  });

  it('formatSearch lists hits with total', () => {
    const out = formatSearch('log', [login], 1);
    expect(out).toContain('命中 1 条');
    expect(out).toContain('• login (function) — src/user.ts:88:2');
  });

  it('formatSearch handles no results', () => {
    expect(formatSearch('zzz', [], 0)).toContain('未找到');
  });

  it('formatRepoStatus marks current repo and no-graph state', () => {
    const out = formatRepoStatus('demo', [{ repoName: 'demo', hasGraph: true, totalNodes: 10, totalEdges: 5 }]);
    expect(out).toContain('当前加载仓库：demo');
    expect(out).toContain('→ demo');
    expect(formatRepoStatus(null, [])).toContain('当前未加载任何仓库');
  });

  it('formatAskResponse renders answer, evidence, docs and graph summary compactly', () => {
    const response: AskResponse = {
      answer: '结论：保存后刷新列表。',
      evidence: [{ file: 'src/List.vue', line: 12, code: 'reloadList()', label: '状态刷新' }],
      docEvidence: [{
        docId: 'd1',
        title: '需求说明',
        source: 'docs/spec.md',
        snippet: '保存成功后需要刷新列表。',
        score: 0.9,
      }],
      graph: { nodes: [login], edges: [] },
      intent: 'CLICK_FLOW',
      confidence: 0.82,
      followUp: ['这个接口失败怎么处理？'],
      conversationId: 'c1',
    };

    const out = formatAskResponse('保存后做了什么？', response);
    expect(out).toContain('问题：保存后做了什么？');
    expect(out).toContain('意图：CLICK_FLOW');
    expect(out).toContain('src/List.vue:12');
    expect(out).toContain('需求说明');
    expect(out).toContain('login (function)');
    expect(out).toContain('这个接口失败怎么处理？');
  });

  it('clampText：结果总长（含省略标记）不超声明上限，且不劈开代理对', () => {
    // ASCII：总长 ≤ limit 且带标记
    const ascii = clampText('a'.repeat(100), 50);
    expect(ascii.length).toBeLessThanOrEqual(50);
    expect(ascii).toContain('已省略');
    // 全 emoji：切点落在代理对中间时回退，正文不得以落单高位代理项结尾
    const emoji = clampText('😀'.repeat(100), 51);
    expect(emoji.length).toBeLessThanOrEqual(51);
    const body = emoji.slice(0, emoji.indexOf('\n...'));
    expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
    // 不超限时原样返回
    expect(clampText('short', 50)).toBe('short');
  });

  it('formatAskResponse 截断行为：单条证据钳制、省略尾、总长上限、空答案兜底、repoName 行', () => {
    const bigEvidence = Array.from({ length: 12 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      code: 'x'.repeat(5000), // 单条 minified 长行：必须被钳到 EVIDENCE_CODE_LIMIT
      label: '证据',
    }));
    const response: AskResponse = {
      answer: '答'.repeat(5000), // 超 2600 的长答案
      evidence: bigEvidence,
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: ['追问一', '追问二', '追问三', '追问四'],
      repoName: 'elink-pc',
    };

    const out = formatAskResponse('q', response);
    expect(out.length).toBeLessThanOrEqual(8000); // 验收口径：默认工具文本 ≤ 8k（含标记）
    expect(out).toContain('仓库：elink-pc');
    expect(out).toContain('另有 2 条代码证据已省略'); // 12 条只展示 10 条
    expect(out).toContain('追问三');
    expect(out).not.toContain('追问四'); // followUp 只取前 3
    // 单条证据被钳：首条渲染行远小于原始 5000 字符
    const firstEvidenceLine = out.split('\n').find((l) => l.includes('src/f0.ts'))!;
    expect(firstEvidenceLine.length).toBeLessThan(400);

    // 空答案兜底 + 无文档分支
    const empty = formatAskResponse('q', { ...response, answer: '  ', evidence: [], docEvidence: undefined });
    expect(empty).toContain('（空回答）');
    expect(empty).toContain('（无代码证据）');
    expect(empty).not.toContain('文档证据');
  });

  it('formatAskResponse 的会话 fork 提示：仅在请求 id 与响应 id 不一致时出现', () => {
    const base: AskResponse = {
      answer: 'ok',
      evidence: [],
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: [],
      conversationId: 'real-id',
    };

    // 不一致 → 显式提示 + 指向新 id
    const forked = formatAskResponse('q', base, { requestedConversationId: 'dead-id' });
    expect(forked).toContain('已新开会话');
    expect(forked).toContain('dead-id');
    // 一致 → 无提示
    expect(formatAskResponse('q', base, { requestedConversationId: 'real-id' })).not.toContain('已新开会话');
    // 未请求复用（无状态问答）→ 无提示
    expect(formatAskResponse('q', base)).not.toContain('已新开会话');
  });
});

// ============ 紧凑成本摘要（§4.5，评审 P5）============

import type { TurnUsageSummary } from '@aiops/shared-types';
import { formatUsageLine, formatProposal } from '../src/format.js';

function usageSummary(over: Partial<TurnUsageSummary> = {}): TurnUsageSummary {
  return {
    turnId: 't1',
    executionStatus: 'completed',
    settlementStatus: 'settled',
    settled: true,
    partial: false,
    partialReasons: [],
    callCount: 3,
    successCallCount: 3,
    errorCallCount: 0,
    abortedCallCount: 0,
    usageMissingCalls: 0,
    usageWarningCalls: 0,
    unknownPricingCalls: 0,
    droppedUsageRecords: 0,
    lateDroppedEvents: 0,
    backgroundFailedJobs: 0,
    backgroundTimedOutJobs: 0,
    promptTokens: 1000,
    cacheHitTokens: 600,
    cacheMissTokens: 400,
    completionTokens: 200,
    reasoningTokens: 0,
    totalTokens: 1200,
    knownCostNanoCny: 812_000,
    updatedAt: 0,
    ...over,
  };
}

describe('formatUsageLine（§4.5 紧凑成本摘要）', () => {
  it('完整成本：tokens/次数/金额一行', () => {
    expect(formatUsageLine(usageSummary())).toEqual(['成本：1.2k tokens · 3 次调用 · ¥0.000812']);
  });

  it('partial 时明说"部分成本"，未结算标注"结算中"', () => {
    const [line] = formatUsageLine(usageSummary({ partial: true, settled: false, settlementStatus: 'pending' }));
    expect(line).toContain('部分成本 ¥0.000812');
    expect(line).toContain('（结算中）');
  });

  it('正成本永不显示 ¥0：低于展示精度显示 <¥0.000001', () => {
    expect(formatUsageLine(usageSummary({ knownCostNanoCny: 20 }))[0]).toContain('<¥0.000001');
  });

  it('无摘要或零调用（缓存全命中 judge 等）→ 不输出成本行', () => {
    expect(formatUsageLine(undefined)).toEqual([]);
    expect(formatUsageLine(usageSummary({ callCount: 0 }))).toEqual([]);
  });
});

describe('formatProposal 渲染成本（评审 P5）', () => {
  const proposal = {
    proposalId: 'p-1',
    repoName: 'demo',
    question: '修个东西',
    unifiedDiff: '--- a/x\n+++ b/x\n',
    files: [{ file: 'x.ts', baselineSha256: 'a'.repeat(64), reason: '' }],
    verifyCommands: [],
    validatedAt: '2026-07-30',
  };

  it('成功提案头部带成本行（clamp 保头弃尾，大 diff 砍不到）', () => {
    const out = formatProposal({ ok: true, proposal, tokenUsageSummary: usageSummary() });
    expect(out).toContain('成本：1.2k tokens');
    expect(out.indexOf('成本：')).toBeLessThan(out.indexOf('统一 diff'));
  });

  it('业务失败（打不上的 diff）也渲染成本——失败同样花了钱', () => {
    const out = formatProposal({ ok: false, reason: 'PATCH_NOT_APPLICABLE', tokenUsageSummary: usageSummary() });
    expect(out).toContain('未能生成可干净应用的补丁');
    expect(out).toContain('成本：1.2k tokens');
  });
});
