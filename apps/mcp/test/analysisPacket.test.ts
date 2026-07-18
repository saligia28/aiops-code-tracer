import { describe, it, expect } from 'vitest';
import type { AskResponse } from '@aiops/shared-types';
import { assembleAnalysisPacket } from '../src/analysisPacket.js';
import { formatAnalysisPacket } from '../src/format.js';

/**
 * prepare_fix_context 的组装/格式化验收（纯函数，无网络）。
 * 对应 fixture repo「订单作废」链路的 E2E 用例 A + 家风 judge 维度：
 *   D1 入口对不对：entry 命中作废入口页；
 *   D2 修改点是否可执行：suggestedEditLocations 全部指向真实文件（entry ∪ 证据/图谱文件），
 *      且覆盖 gold 改点（api/orderVoid.ts 或 orderVoid/List.vue）。
 */

// 代表性 AskResponse：模拟 /api/ask 对「订单作废按钮点击后做了什么？」的返回（含 additive entry）
const ORDER_VOID_RESPONSE: AskResponse = {
  answer:
    '结论：点击"作废"按钮后，handleVoid 先校验 status===2（已审核）再调 voidOrder 接口作废订单。\n' +
    '相关代码：src/views/orderManage/orderVoid/List.vue:31、src/api/orderVoid.ts:5',
  evidence: [
    {
      file: 'src/views/orderManage/orderVoid/List.vue',
      line: 31,
      code: 'handleVoid(row) { if (row.status !== this.voidableStatus) return; return voidOrder(row.id) }',
      label: '点击处理',
    },
    { file: 'src/api/orderVoid.ts', line: 5, code: "return axios.post('/api/order/void', { id })", label: '接口调用' },
  ],
  graph: {
    nodes: [
      {
        id: 'function:src/views/orderManage/orderVoid/List.vue:handleVoid',
        type: 'function',
        name: 'handleVoid',
        filePath: 'src/views/orderManage/orderVoid/List.vue',
        loc: '31:4',
      },
      {
        id: 'apiCall:src/api/orderVoid.ts:voidOrder',
        type: 'apiCall',
        name: 'voidOrder',
        filePath: 'src/api/orderVoid.ts',
        loc: '5:9',
        meta: { apiMethod: 'post', apiEndpoint: '/api/order/void' },
      },
      // import/file 节点应被排除出 relatedFiles/apiCalls（结构噪声）
      { id: 'import:src/views/orderManage/orderVoid/List.vue:axios', type: 'import', name: 'axios', filePath: 'src/views/orderManage/orderVoid/List.vue', loc: '13:0' },
    ],
    edges: [
      {
        from: 'function:src/views/orderManage/orderVoid/List.vue:handleVoid',
        to: 'apiCall:src/api/orderVoid.ts:voidOrder',
        type: 'calls',
        meta: { confidence: 'high' },
      },
    ],
  },
  intent: 'CLICK_FLOW',
  confidence: 0.85,
  followUp: [],
  repoName: 'eval-fixture',
  entry: {
    file: 'src/views/orderManage/orderVoid/List.vue',
    line: 31,
    symbol: 'handleVoid',
    reason: '页面「订单作废管理」链路的检索起点',
  },
};

describe('assembleAnalysisPacket（tier-1 规则组装）', () => {
  const packet = assembleAnalysisPacket('订单作废按钮点击后做了什么？', ORDER_VOID_RESPONSE);

  it('D1 入口对不对：entry 透传自 AskResponse，命中作废入口页', () => {
    expect(packet.entry?.file).toBe('src/views/orderManage/orderVoid/List.vue');
    expect(packet.entry?.symbol).toBe('handleVoid');
  });

  it('relatedFiles 去重保序（证据优先），排除 import/file 噪声节点', () => {
    expect(packet.relatedFiles).toEqual([
      'src/views/orderManage/orderVoid/List.vue',
      'src/api/orderVoid.ts',
    ]);
  });

  it('apiCalls 从 apiCall 节点抽取 method+endpoint+file+line', () => {
    expect(packet.apiCalls).toContainEqual({
      method: 'post',
      endpoint: '/api/order/void',
      file: 'src/api/orderVoid.ts',
      line: 5,
    });
  });

  it('flowSteps 优先图谱调用链（真实边）', () => {
    expect(packet.flowSteps.length).toBe(1);
    expect(packet.flowSteps[0].title).toContain('handleVoid');
    expect(packet.flowSteps[0].title).toContain('--calls-->');
    expect(packet.flowSteps[0].title).toContain('voidOrder');
  });

  it('D2 修改点可执行：suggestedEditLocations 全部指向真实文件，且覆盖 gold 改点', () => {
    expect(packet.suggestedEditLocations.length).toBeGreaterThan(0);
    // 每条修改点都必须是真实文件（入口 ∪ 相关文件），不能是幻觉路径
    const realFiles = new Set([packet.entry!.file, ...packet.relatedFiles]);
    for (const loc of packet.suggestedEditLocations) {
      expect(realFiles.has(loc.file)).toBe(true);
    }
    // gold：改作废行为要动的两处——入口页 + 接口定义——都在建议里
    const editFiles = packet.suggestedEditLocations.map((l) => l.file);
    expect(editFiles).toContain('src/views/orderManage/orderVoid/List.vue');
    expect(editFiles).toContain('src/api/orderVoid.ts');
  });

  it('tier-3 诚实降级：verificationHints 接地（有接口+入口），riskPoints v1 留空', () => {
    expect(packet.verificationHints.some((h) => h.includes('/api/order/void'))).toBe(true);
    expect(packet.verificationHints.some((h) => h.includes('断点'))).toBe(true);
    expect(packet.riskPoints).toEqual([]); // 不硬凑空话
  });
});

describe('assembleAnalysisPacket（供给缺口时的降级）', () => {
  it('无 entry / 无图谱：suggestedEditLocations 退化为证据文件（仍可执行），flowSteps 退化为证据序列', () => {
    const minimal: AskResponse = {
      answer: '结论：在 src/utils/format.ts:2 的 formatDate 里格式化。',
      evidence: [{ file: 'src/utils/format.ts', line: 2, code: 'export function formatDate(...)', label: '关键代码' }],
      graph: { nodes: [], edges: [] },
      intent: 'GENERAL',
      confidence: 0.5,
      followUp: [],
    };
    const packet = assembleAnalysisPacket('日期格式化在哪？', minimal);
    expect(packet.entry).toBeUndefined();
    // 无边 → flowSteps 退化为证据序列
    expect(packet.flowSteps[0].title).toBe('关键代码');
    // 无 entry → 修改点仍从证据文件接地（可执行）
    expect(packet.suggestedEditLocations.map((l) => l.file)).toContain('src/utils/format.ts');
    // 无接口 + 无 entry → verificationHints 为空（不硬造），riskPoints 空
    expect(packet.verificationHints).toEqual([]);
    expect(packet.riskPoints).toEqual([]);
  });
});

describe('formatAnalysisPacket（输出格式）', () => {
  const packet = assembleAnalysisPacket('订单作废按钮点击后做了什么？', ORDER_VOID_RESPONSE);
  const out = formatAnalysisPacket(packet);

  it('包含入口/流程/接口/修改点/证据各段与仓库标识', () => {
    expect(out).toContain('仓库：eval-fixture');
    expect(out).toContain('入口：');
    expect(out).toContain('src/views/orderManage/orderVoid/List.vue:31');
    expect(out).toContain('关键流程：');
    expect(out).toContain('接口调用');
    expect(out).toContain('POST /api/order/void');
    expect(out).toContain('疑似修改点');
  });

  it('tier-3 出处显式标注：修改点标"非 LLM 判断"，风险点标 v1 降级', () => {
    expect(out).toContain('非 LLM 判断');
    expect(out).toContain('v1 暂不做风险推断');
  });

  it('输出总长受控 ≤ 8k（含省略标记）', () => {
    expect(out.length).toBeLessThanOrEqual(8000);
  });
});
