import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  analyzerGet: vi.fn(),
  analyzerPost: vi.fn(),
  getRepoLock: vi.fn(() => ''),
  AnalyzerError: class extends Error {},
}));

import { analyzerGet, analyzerPost } from '../src/client.js';
import { searchSymbols } from '../src/tools/searchSymbols.js';
import { traceCallees } from '../src/tools/traceCallees.js';
import { traceCallers } from '../src/tools/traceCallers.js';
import { explainCodeLogic } from '../src/tools/explainCodeLogic.js';
import { prepareFixContext } from '../src/tools/prepareFixContext.js';
import { getImpactScope } from '../src/tools/getImpactScope.js';
import { allTools } from '../src/tools/index.js';

const mockGet = analyzerGet as unknown as ReturnType<typeof vi.fn>;
const mockPost = analyzerPost as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
});

describe('tools', () => {
  it('exposes the MCP tools including task-level analysis', () => {
    expect(allTools.map((t) => t.name).sort()).toEqual(
      [
        'explain_code_logic',
        'prepare_fix_context',
        'get_impact_scope',
        'get_file_graph',
        'get_symbol',
        'repo_status',
        'search_symbols',
        'trace_callees',
        'trace_callers',
      ].sort(),
    );
  });

  it('search_symbols maps params to /api/search and formats', async () => {
    mockGet.mockResolvedValue({ query: 'login', total: 1, results: [{ id: 'function:a.ts:login', type: 'function', name: 'login', filePath: 'a.ts', loc: '1:0' }] });
    const out = await searchSymbols.handler({ q: 'login', limit: 10 });
    expect(mockGet).toHaveBeenCalledWith('/api/search', { q: 'login', limit: 10 });
    expect(out.content[0].text).toContain('login (function) — a.ts:1:0');
  });

  it('trace_callees hits /api/trace with symbol param', async () => {
    mockGet.mockResolvedValue({ symbol: 'x', nodeId: 'n', depth: 3, nodes: [], edges: [] });
    await traceCallees.handler({ symbol: 'x' });
    expect(mockGet).toHaveBeenCalledWith('/api/trace', { symbol: 'x', depth: undefined });
  });

  it('trace_callers hits /api/why with target param (symbol→target)', async () => {
    mockGet.mockResolvedValue({ target: 'x', nodeId: 'n', depth: 3, nodes: [], edges: [] });
    await traceCallers.handler({ symbol: 'x' });
    expect(mockGet).toHaveBeenCalledWith('/api/why', { target: 'x', depth: undefined });
  });

  it('handles SYMBOL_NOT_FOUND as a friendly non-error', async () => {
    mockGet.mockResolvedValue({ symbol: 'x', depth: 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' });
    const out = await traceCallees.handler({ symbol: 'x' });
    expect(out.content[0].text).toContain('未找到');
    expect(out.isError).toBeFalsy();
  });

  it('explain_code_logic posts to /api/ask with source:mcp and dedicated long timeout', async () => {
    mockPost.mockResolvedValue({
      answer: '结论：保存后刷新列表。',
      evidence: [{ file: 'src/List.vue', line: 12, code: 'reloadList()', label: '状态刷新' }],
      graph: { nodes: [], edges: [] },
      intent: 'CLICK_FLOW',
      confidence: 0.8,
      followUp: [],
      conversationId: 'c1',
    });

    const out = await explainCodeLogic.handler({ question: '保存后做了什么？', conversationId: 'c1' });

    // source:'mcp' = 服务端跳过记忆抽取/无 id 时不落库；timeoutMs = ask 专用长超时（默认 120s）
    expect(mockPost).toHaveBeenCalledWith(
      '/api/ask',
      { question: '保存后做了什么？', conversationId: 'c1', source: 'mcp' },
      { timeoutMs: 120_000 },
    );
    expect(out.content[0].text).toContain('保存后做了什么');
    expect(out.content[0].text).toContain('src/List.vue:12');
    // 请求 id 与响应 id 一致：不应出现"已新开会话"提示
    expect(out.content[0].text).not.toContain('已新开会话');
  });

  it('explain_code_logic 提示会话 fork：请求的 conversationId 与响应不一致时显式告知', async () => {
    mockPost.mockResolvedValue({
      answer: '结论：ok。',
      evidence: [],
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: [],
      conversationId: 'new-id',
    });

    const out = await explainCodeLogic.handler({ question: '继续上个话题', conversationId: 'stale-id' });
    expect(out.content[0].text).toContain('已新开会话');
    expect(out.content[0].text).toContain('new-id');
  });

  it('prepare_fix_context posts to /api/ask (stateless source:mcp) and assembles a fix-context packet', async () => {
    mockPost.mockResolvedValue({
      answer: '结论：handleVoid 校验 status===2 后调 voidOrder 作废订单。',
      evidence: [
        { file: 'src/views/orderManage/orderVoid/List.vue', line: 31, code: 'return voidOrder(row.id)', label: '点击处理' },
        { file: 'src/api/orderVoid.ts', line: 5, code: "axios.post('/api/order/void', { id })", label: '接口调用' },
      ],
      graph: {
        nodes: [
          { id: 'apiCall:src/api/orderVoid.ts:voidOrder', type: 'apiCall', name: 'voidOrder', filePath: 'src/api/orderVoid.ts', loc: '5:9', meta: { apiMethod: 'post', apiEndpoint: '/api/order/void' } },
        ],
        edges: [],
      },
      intent: 'CLICK_FLOW',
      confidence: 0.85,
      followUp: [],
      repoName: 'eval-fixture',
      entry: { file: 'src/views/orderManage/orderVoid/List.vue', line: 31, symbol: 'handleVoid', reason: '页面锚点：订单作废管理' },
    });

    const out = await prepareFixContext.handler({ question: '订单作废按钮点击后做了什么？' });

    // 无状态：无 conversationId，source:'mcp'，ask 专用长超时（默认 120s）
    expect(mockPost).toHaveBeenCalledWith(
      '/api/ask',
      { question: '订单作废按钮点击后做了什么？', source: 'mcp', taskProfile: 'fix_context' },
      { timeoutMs: 120_000 },
    );
    const t = out.content[0].text;
    expect(t).toContain('入口：');
    expect(t).toContain('src/views/orderManage/orderVoid/List.vue:31');
    expect(t).toContain('POST /api/order/void');
    expect(t).toContain('疑似修改点');
    expect(t).toContain('非 LLM 判断'); // tier-3 出处显式标注
  });

  it('get_impact_scope 合并 /api/why（上游）+ /api/trace（下游）为影响面', async () => {
    // 上游 callers（/api/why，query 参数 target）
    mockGet.mockImplementation(async (path: string) => {
      if (path === '/api/why') {
        return { target: 'voidOrder', depth: 3, nodes: [{ id: 'function:List.vue:handleVoid', type: 'function', name: 'handleVoid', filePath: 'src/views/orderManage/orderVoid/List.vue', loc: '31:4' }], edges: [] };
      }
      // 下游 callees（/api/trace）
      return { symbol: 'voidOrder', depth: 3, nodes: [{ id: 'apiCall:orderVoid.ts:post', type: 'apiCall', name: 'axios.post', filePath: 'src/api/orderVoid.ts', loc: '6:9', meta: { apiMethod: 'post', apiEndpoint: '/api/order/void' } }], edges: [] };
    });

    const out = await getImpactScope.handler({ symbol: 'voidOrder' });

    expect(mockGet).toHaveBeenCalledWith('/api/why', { target: 'voidOrder', depth: undefined });
    expect(mockGet).toHaveBeenCalledWith('/api/trace', { symbol: 'voidOrder', depth: undefined });
    const t = out.content[0].text;
    expect(t).toContain('上游影响面');
    expect(t).toContain('handleVoid'); // 调用方
    expect(t).toContain('下游依赖面');
    expect(t).toContain('axios.post'); // 被依赖
  });

  it('get_impact_scope 两侧都 SYMBOL_NOT_FOUND 时提示先 search_symbols', async () => {
    mockGet.mockResolvedValue({ depth: 3, nodes: [], edges: [], message: 'SYMBOL_NOT_FOUND' });
    const out = await getImpactScope.handler({ symbol: 'nope' });
    expect(out.content[0].text).toContain('未找到');
    expect(out.content[0].text).toContain('search_symbols');
    expect(out.isError).toBeFalsy();
  });

  it('get_impact_scope file 模式：两个端点都带 file 参数，输出标注聚合口径', async () => {
    mockGet.mockImplementation(async (path: string) => {
      if (path === '/api/why') {
        return { file: 'src/api/orderVoid.ts', depth: 3, sourceSymbols: 2, nodes: [{ id: 'function:List.vue:handleVoid', type: 'function', name: 'handleVoid', filePath: 'src/views/orderManage/orderVoid/List.vue', loc: '31:4' }], edges: [] };
      }
      return { file: 'src/api/orderVoid.ts', depth: 3, sourceSymbols: 2, nodes: [], edges: [] };
    });

    const out = await getImpactScope.handler({ file: 'src/api/orderVoid.ts', depth: 2 });

    expect(mockGet).toHaveBeenCalledWith('/api/why', { file: 'src/api/orderVoid.ts', depth: 2 });
    expect(mockGet).toHaveBeenCalledWith('/api/trace', { file: 'src/api/orderVoid.ts', depth: 2 });
    const t = out.content[0].text;
    expect(t).toContain('文件 "src/api/orderVoid.ts"');
    expect(t).toContain('聚合 2 个符号');
    expect(t).toContain('handleVoid');
  });

  it('get_impact_scope 短文件名多命中：候选列表原样透出，指引换完整路径', async () => {
    mockGet.mockResolvedValue({
      file: 'List.vue', depth: 3, nodes: [], edges: [],
      message: 'FILE_AMBIGUOUS',
      candidates: ['src/views/a/List.vue', 'src/views/b/List.vue'],
    });
    const out = await getImpactScope.handler({ file: 'List.vue' });
    const t = out.content[0].text;
    expect(t).toContain('命中多个路径');
    expect(t).toContain('src/views/a/List.vue');
    expect(t).toContain('src/views/b/List.vue');
  });

  it('get_impact_scope 入参互斥：symbol 与 file 同传/都不传直接报错，不发请求', async () => {
    await expect(getImpactScope.handler({ symbol: 'x', file: 'y.ts' })).rejects.toThrow('只能提供一个');
    await expect(getImpactScope.handler({})).rejects.toThrow('只能提供一个');
    expect(mockGet).not.toHaveBeenCalled();
  });
});
