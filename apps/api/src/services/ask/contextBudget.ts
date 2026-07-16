/**
 * 上下文预算收敛（P2-H）—— 把散落在 ask/agent 链路里的「拍脑袋常量」收到一处，
 * env 可调 + 有据可查。
 *
 * 动机：CODE_BUDGET=6000 这类值最初是手感值，合不合理没人知道——因为没有观测数据。
 * 本模块做两件事：
 *   1. 预算集中定义，默认值 = 收敛前的原值（不改任何行为，纯搬家零回归）；
 *      env 覆盖只在「观测数据表明该调」时用，调完把结论写回默认值。
 *   2. 配套 ask.ts 的 context_assembly trace span：每段实际 token 用量 / 预算利用率
 *      进 Langfuse，让「反推合理值」有数据可依。
 *
 * 边界（改动前请读）：
 *   - token 预算基于 estimateTokens 的本地估算（chars/3 级近似），与模型真实计数有偏差；
 *     预算的意义是「控制上限防爆 prompt」，不是精确配额，所以估算够用。
 *   - env 解析失败（非数字/非正数）静默回退默认值——预算配错不该让服务起不来。
 *   - 每次调用现读 env（无缓存）：预算只在请求链路低频读取，可忽略开销；
 *     换来测试可以逐用例改 env 而无需 reset 钩子。
 */

/** ask 链路各段的 token 预算（默认值 = P2-H 收敛前散落各处的原常量）。 */
export interface ContextBudgets {
  /** 代码片段上下文（assembleCodeContext），原 ask.ts CODE_BUDGET */
  code: number;
  /** 证据线索（buildEvidenceHints），原 ask.ts EVIDENCE_BUDGET */
  evidence: number;
  /** 调用关系图文本（buildGraphContext 后裁剪），原 ask.ts GRAPH_BUDGET */
  graph: number;
  /** 多轮历史窗口（buildLlmHistory / buildHistoryWindow），原 ask.ts/agent.ts 硬编码 1500 */
  history: number;
}

const BUDGET_DEFAULTS: ContextBudgets = {
  code: 6000,
  evidence: 1500,
  graph: 800,
  history: 1500,
};

/** agent 循环消息压缩的触发阈值（字符数），原 agentLoop.ts compressMessages 硬编码。 */
export interface AgentCompressThresholds {
  /** 轻度压缩：折叠较早 tool 结果（阈值 500 字） */
  lightChars: number;
  /** 重度压缩：折叠阈值降到 150 字 + 清早期 reasoning_content */
  heavyChars: number;
}

const COMPRESS_DEFAULTS: AgentCompressThresholds = {
  lightChars: 20_000,
  heavyChars: 40_000,
};

/** 解析正整数 env，缺失/非法一律回退默认值（预算配错不该影响服务可用性）。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function getContextBudgets(): ContextBudgets {
  return {
    code: parsePositiveInt(process.env.CONTEXT_CODE_BUDGET, BUDGET_DEFAULTS.code),
    evidence: parsePositiveInt(process.env.CONTEXT_EVIDENCE_BUDGET, BUDGET_DEFAULTS.evidence),
    graph: parsePositiveInt(process.env.CONTEXT_GRAPH_BUDGET, BUDGET_DEFAULTS.graph),
    history: parsePositiveInt(process.env.CONTEXT_HISTORY_BUDGET, BUDGET_DEFAULTS.history),
  };
}

export function getAgentCompressThresholds(): AgentCompressThresholds {
  const light = parsePositiveInt(process.env.AGENT_COMPRESS_LIGHT_CHARS, COMPRESS_DEFAULTS.lightChars);
  let heavy = parsePositiveInt(process.env.AGENT_COMPRESS_HEAVY_CHARS, COMPRESS_DEFAULTS.heavyChars);
  // 阈值倒挂（heavy ≤ light）时纠正为 light 的 2 倍，保持「先轻后重」的渐进语义
  if (heavy <= light) heavy = light * 2;
  return { lightChars: light, heavyChars: heavy };
}
