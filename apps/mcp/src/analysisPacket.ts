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
  /** 风险点：来自答案的「风险点」小节（taskProfile=fix_context 的 prompt 契约）；无小节则空。 */
  riskPoints: string[];
  /** 疑似修改点：LLM 小节优先，接地启发式（入口 + 证据文件）补位。 */
  suggestedEditLocations: Array<{ file: string; line?: number; reason: string }>;
  /** 验证建议：LLM 小节优先，无则接地启发式（接口 / 入口）。 */
  verificationHints: string[];
  /**
   * tier-3 字段来源（formatter 据此写标注，消费端据此定信任度）：
   * llm = 答案小节解析（模型基于材料判断）；heuristic = 规则启发式；none = 无内容。
   */
  sources: {
    suggestedEdits: 'llm' | 'heuristic' | 'none';
    verificationHints: 'llm' | 'heuristic' | 'none';
    riskPoints: 'llm' | 'none';
  };
  /** 原始代码证据（透传 AskResponse.evidence）。 */
  evidence: Evidence[];
}

/** 三小节标题（与 ask.ts FIX_CONTEXT_APPENDIX 的 prompt 契约同步，改动须两边一致）。 */
const FIX_SECTION_TITLES = ['疑似修改点', '风险点', '验证建议'] as const;
type FixSectionTitle = (typeof FIX_SECTION_TITLES)[number];

const SECTION_HEADER_RE = new RegExp(`^[\\s#>*]*(${FIX_SECTION_TITLES.join('|')})[：:]\\s*$`);
/** 任意「xxx：」形式的独行标题（用于终结当前小节，容忍模型自创小节） */
const ANY_HEADER_RE = /^[\s#>*]*[^\s\-•·].{0,24}[：:]\s*$/;
const BULLET_RE = /^\s*(?:[-•·]|\d+[.、)])\s*(.+)$/;
// 行号容忍 L 前缀与范围（活体 E2E 实测模型爱写 `List.vue:L196-L210`，取范围起始行）
const FILE_LINE_RE = /([\w@./-]+\.(?:vue|ts|js|tsx|jsx|java|py|go))\s*[:：]\s*L?(\d+)?/;

export interface FixSections {
  editLocations: Array<{ file: string; line?: number; reason: string }>;
  riskPoints: string[];
  verificationHints: string[];
  /** 答案中首个小节标题的下标——answer 主体到此为止（小节内容已进结构化字段，别重复占预算） */
  sectionStart: number;
}

/**
 * 从 LLM 答案中解析「修改前分析模式」的三个小节（prompt 契约见 ask.ts FIX_CONTEXT_APPENDIX）。
 * 未走 LLM 路径 / 模型未遵循格式时返回 null——调用方回退接地启发式，绝不硬凑。
 */
export function parseFixSections(answer: string): FixSections | null {
  const out: Record<FixSectionTitle, string[]> = { 疑似修改点: [], 风险点: [], 验证建议: [] };
  let current: FixSectionTitle | null = null;
  let sectionStart = -1;
  let offset = 0;

  for (const rawLine of answer.split('\n')) {
    const lineOffset = offset;
    offset += rawLine.length + 1;
    const header = rawLine.match(SECTION_HEADER_RE);
    if (header) {
      if (sectionStart < 0) sectionStart = lineOffset;
      current = header[1] as FixSectionTitle;
      continue;
    }
    if (!current) continue;
    const bullet = rawLine.match(BULLET_RE);
    if (bullet) {
      const item = bullet[1].trim();
      if (item) out[current].push(item);
      continue;
    }
    // 非条目行：其他小节标题或普通段落 → 当前小节结束（容忍小节间空行）
    if (rawLine.trim() && ANY_HEADER_RE.test(rawLine)) current = null;
  }

  const editLocations: FixSections['editLocations'] = [];
  for (const item of out['疑似修改点']) {
    const m = item.match(FILE_LINE_RE);
    if (!m) continue; // 无文件锚的修改点不进结构化字段（原文仍在 answer 里）
    editLocations.push({
      file: m[1],
      line: m[2] ? Number.parseInt(m[2], 10) : undefined,
      reason: item,
    });
  }

  const riskPoints = out['风险点'];
  const verificationHints = out['验证建议'];
  if (editLocations.length === 0 && riskPoints.length === 0 && verificationHints.length === 0) return null;
  return { editLocations, riskPoints, verificationHints, sectionStart };
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

  // ===== tier-3：LLM 小节优先（taskProfile=fix_context 的 prompt 契约），启发式补位 =====
  const parsed = parseFixSections(response.answer ?? '');

  // 短文件名归一（活体 E2E 实测模型爱写 `List.vue:196` 短名）：入口文件优先消歧
  // （Vue 仓库满地都是 List.vue，多命中很常见，而修改点绝大多数就在入口页），
  // 其次 relatedFiles 唯一后缀命中；仍歧义则保留原样（宁可短名也不猜错文件）
  const normalizeFile = (file: string): string => {
    if (file.includes('/')) return file;
    const entryFile = response.entry?.file;
    if (entryFile && (entryFile === file || entryFile.endsWith(`/${file}`))) return entryFile;
    const hits = relatedFiles.filter((f) => f === file || f.endsWith(`/${file}`));
    return hits.length === 1 ? hits[0] : file;
  };

  const suggestedEditLocations: AnalysisPacket['suggestedEditLocations'] = [];
  const seenEdit = new Set<string>();
  const pushEdit = (file: string | undefined, line: number | undefined, reason: string): void => {
    if (!file) return;
    const key = `${file}:${line ?? ''}`;
    if (seenEdit.has(key)) return;
    seenEdit.add(key);
    suggestedEditLocations.push({ file, line, reason });
  };
  // LLM 判断的修改点排最前（模型基于材料给的"为什么改这里"比启发式的"承载证据"信息量大）
  for (const e of parsed?.editLocations ?? []) pushEdit(normalizeFile(e.file), e.line, e.reason);
  if (response.entry) pushEdit(response.entry.file, response.entry.line, `入口：${response.entry.reason}`);
  for (const e of evidence.slice(0, 4)) pushEdit(e.file, e.line, `承载证据「${e.label}」`);

  const heuristicHints: string[] = [];
  for (const a of apiCalls.slice(0, 3)) {
    heuristicHints.push(`核对接口 ${(a.method ?? '').toUpperCase()} ${a.endpoint} 的入参与返回是否符合改动预期`.replace(/\s+/g, ' ').trim());
  }
  if (response.entry) {
    const loc = response.entry.line ? `:${response.entry.line}` : '';
    heuristicHints.push(`在 ${response.entry.file}${loc}（${response.entry.symbol ?? '入口'}）打断点，确认触发路径与改动生效`);
  }
  const verificationHints = parsed?.verificationHints.length ? parsed.verificationHints : heuristicHints;

  const riskPoints = parsed?.riskPoints ?? [];

  const sources: AnalysisPacket['sources'] = {
    suggestedEdits:
      parsed?.editLocations.length ? 'llm' : suggestedEditLocations.length > 0 ? 'heuristic' : 'none',
    verificationHints: parsed?.verificationHints.length ? 'llm' : heuristicHints.length > 0 ? 'heuristic' : 'none',
    riskPoints: riskPoints.length > 0 ? 'llm' : 'none',
  };

  // 小节内容已进结构化字段：answer 主体裁到首个小节标题为止，别在证据包里重复占预算
  const rawAnswer = response.answer ?? '';
  const answer =
    parsed && parsed.sectionStart > 0 ? rawAnswer.slice(0, parsed.sectionStart).trimEnd() : rawAnswer;

  return {
    question,
    answer,
    repoName: response.repoName,
    entry: response.entry,
    flowSteps,
    relatedFiles,
    apiCalls,
    riskPoints,
    suggestedEditLocations,
    verificationHints,
    sources,
    evidence,
  };
}
