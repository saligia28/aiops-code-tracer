/**
 * AnalysisPacket —— 面向"改代码前先理解"的结构化证据包（P1-MCP 第二刀）。
 *
 * 只在 MCP 层从 `AskResponse` 规则组装，不改 `/api/ask` 公共协议（roadmap 允许的第一版路径）。
 * 字段按"可得性"分档，避免"看起来结构化、实际是空话"的伪字段（review 家风）：
 *
 *   规则可组装（tier-1，直接投影 AskResponse）：
 *     question / answer / repoName / entry / flowSteps / relatedFiles / apiCalls / evidence
 *   LLM 判断（tier-3，规则组不出来）：诚实降级，绝不硬凑——
 *     - suggestedEditLocations：接地启发式（入口 + 承载关键证据的文件），非 LLM 判断，formatter 标注；
 *     - verificationHints：接地启发式（有接口/入口才给），非 LLM 判断；
 *     - riskPoints：v1 留空（真·LLM 判断，规则投影只会产出空话，比不给更误导消费端）；
 *       计划走 `/api/ask` systemPrompt 按 source 加输出段落下沉（prompt 改动而非管线改动）。
 *
 * `entry` 依赖 AskResponse 的 additive `entry` 字段（服务端 anchor/startNode 下沉，与 repoName 同款）；
 * 服务端未下发时该字段缺省，suggestedEditLocations 退化为纯证据文件（仍可执行）。
 */
import type { AskResponse, Evidence, GraphNode } from '@aiops/shared-types';

export interface AnalysisPacket {
  question: string;
  answer: string;
  /** 本次分析基于哪个仓库（消费端切库感知，与 AskResponse.repoName 同源）。 */
  repoName?: string;
  /** 任务入口（"从哪看起 / 从哪改"的锚）；服务端未定位到锚点/起点时缺省。 */
  entry?: { file: string; line?: number; symbol?: string; reason: string };
  /** 关键流程：优先图谱调用链（真实边），无边时退化为证据序列（近似流程）。 */
  flowSteps: Array<{ title: string; file?: string; line?: number; evidence?: string }>;
  /** 相关文件：证据文件 ∪ 图谱实体节点文件，去重保序（证据优先）。 */
  relatedFiles: string[];
  /** 接口调用：图谱 apiCall / 路由节点的 method + endpoint。 */
  apiCalls: Array<{ method?: string; endpoint?: string; file?: string; line?: number }>;
  /** 风险点：LLM 判断字段，v1 留空（见模块头注的降级说明）。 */
  riskPoints: string[];
  /** 疑似修改点：接地启发式（入口 + 证据文件），非 LLM 判断。 */
  suggestedEditLocations: Array<{ file: string; line?: number; reason: string }>;
  /** 验证建议：接地启发式（接口 / 入口），非 LLM 判断。 */
  verificationHints: string[];
  /** 原始代码证据（透传 AskResponse.evidence）。 */
  evidence: Evidence[];
}

/** 从 "line:col" 形式的 loc 抠出行号；非法则 undefined。 */
function locLine(loc: string | undefined): number | undefined {
  if (!loc) return undefined;
  const n = Number.parseInt(loc.split(':')[0], 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 是否是可定位的实体节点（file/import 是结构噪声，不进相关文件/接口）。 */
function isEntityNode(n: GraphNode): boolean {
  return n.type !== 'file' && n.type !== 'import';
}

/**
 * 规则组装 AnalysisPacket。纯函数、无 IO——可脱离网络单测。
 * 输入是 `/api/ask` 的完整 AskResponse（source:'mcp'），输出是消费端可直接执行的证据包。
 */
export function assembleAnalysisPacket(question: string, response: AskResponse): AnalysisPacket {
  const evidence = response.evidence ?? [];
  const nodes = response.graph?.nodes ?? [];
  const edges = response.graph?.edges ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));

  // ===== relatedFiles：证据文件优先，再并入图谱实体节点文件，去重保序 =====
  const relatedFiles: string[] = [];
  const seenFile = new Set<string>();
  const pushFile = (f: string | undefined): void => {
    if (f && !seenFile.has(f)) {
      seenFile.add(f);
      relatedFiles.push(f);
    }
  };
  for (const e of evidence) pushFile(e.file);
  for (const n of nodes) if (isEntityNode(n)) pushFile(n.filePath);

  // ===== apiCalls：图谱 apiCall 节点（apiMethod/apiEndpoint）+ 路由节点（httpMethod/httpPath）=====
  const apiCalls: AnalysisPacket['apiCalls'] = [];
  const seenApi = new Set<string>();
  for (const n of nodes) {
    const method = n.meta?.apiMethod ?? n.meta?.httpMethod;
    const endpoint = n.meta?.apiEndpoint ?? n.meta?.httpPath;
    if (!endpoint) continue;
    const key = `${method ?? ''} ${endpoint}`;
    if (seenApi.has(key)) continue;
    seenApi.add(key);
    apiCalls.push({ method: method ?? undefined, endpoint, file: n.filePath, line: locLine(n.loc) });
  }

  // ===== flowSteps：优先图谱调用链（真实边），空则退化为证据序列（近似流程）=====
  let flowSteps: AnalysisPacket['flowSteps'];
  if (edges.length > 0) {
    flowSteps = edges.slice(0, 8).map((e) => {
      const from = nodeById.get(e.from);
      const to = nodeById.get(e.to);
      return {
        title: `${from?.name ?? e.from} --${e.type}--> ${to?.name ?? e.to}`,
        file: to?.filePath ?? from?.filePath,
        line: to ? locLine(to.loc) : locLine(from?.loc),
        evidence: e.meta?.condition || undefined,
      };
    });
  } else {
    flowSteps = evidence.slice(0, 8).map((e) => ({ title: e.label, file: e.file, line: e.line, evidence: e.code }));
  }

  // ===== tier-3：suggestedEditLocations（接地启发式：入口 + 承载关键证据的文件）=====
  const suggestedEditLocations: AnalysisPacket['suggestedEditLocations'] = [];
  const seenEdit = new Set<string>();
  const pushEdit = (file: string | undefined, line: number | undefined, reason: string): void => {
    if (!file) return;
    const key = `${file}:${line ?? ''}`;
    if (seenEdit.has(key)) return;
    seenEdit.add(key);
    suggestedEditLocations.push({ file, line, reason });
  };
  if (response.entry) pushEdit(response.entry.file, response.entry.line, `入口：${response.entry.reason}`);
  for (const e of evidence.slice(0, 4)) pushEdit(e.file, e.line, `承载证据「${e.label}」`);

  // ===== tier-3：verificationHints（接地启发式：接口 / 入口；无接地则空，不硬造）=====
  const verificationHints: string[] = [];
  for (const a of apiCalls.slice(0, 3)) {
    verificationHints.push(`核对接口 ${(a.method ?? '').toUpperCase()} ${a.endpoint} 的入参与返回是否符合改动预期`.replace(/\s+/g, ' ').trim());
  }
  if (response.entry) {
    const loc = response.entry.line ? `:${response.entry.line}` : '';
    verificationHints.push(`在 ${response.entry.file}${loc}（${response.entry.symbol ?? '入口'}）打断点，确认触发路径与改动生效`);
  }

  // ===== tier-3：riskPoints —— v1 不硬凑（真·LLM 判断），留空由 formatter 标注降级 =====
  const riskPoints: string[] = [];

  return {
    question,
    answer: response.answer ?? '',
    repoName: response.repoName,
    entry: response.entry,
    flowSteps,
    relatedFiles,
    apiCalls,
    riskPoints,
    suggestedEditLocations,
    verificationHints,
    evidence,
  };
}
