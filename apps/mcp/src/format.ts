import type { AskResponse, DocEvidence, Evidence, GraphEdge, GraphNode, TurnUsageSummary } from '@aiops/shared-types';
import type { AnalysisPacket } from './analysisPacket.js';

/**
 * 紧凑成本摘要（设计文档 §4.5）：机器消费端输出末尾/头部的一行人话。
 * 与 Web 面板同纪律：正成本不显示 ¥0（最小已知成本 20 nano = 第 8 位小数）；
 * partial 时明说"部分成本"，不冒充完整总价；未结算（后台任务在跑）时标注。
 */
export function formatUsageLine(summary?: TurnUsageSummary): string[] {
  if (!summary || summary.callCount === 0) return [];
  const nano = summary.knownCostNanoCny;
  const money =
    !Number.isFinite(nano) || nano <= 0
      ? '¥0'
      : nano < 1000
        ? '<¥0.000001'
        : `¥${(nano / 1e9).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  const tok = summary.totalTokens;
  const tokens = tok < 1000 ? String(tok) : `${(tok / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  const cost = summary.partial ? `部分成本 ${money}` : money;
  return [`成本：${tokens} tokens · ${summary.callCount} 次调用 · ${cost}${summary.settled ? '' : '（结算中）'}`];
}

export function formatNode(n: GraphNode): string {
  const kind = n.meta?.kind ? `${n.type}/${n.meta.kind}` : n.type;
  return `${n.name} (${kind}) — ${n.filePath}:${n.loc}`;
}

export function formatGraph(nodes: GraphNode[], edges: GraphEdge[]): string {
  if (nodes.length === 0) return '（无结果）';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  const parts: string[] = [`节点 (${nodes.length}):`, ...nodes.map((n) => `  • ${formatNode(n)}`)];
  if (edges.length > 0) {
    parts.push(`关系 (${edges.length}):`);
    for (const e of edges) {
      const conf = e.meta?.confidence && e.meta.confidence !== 'high' ? ` [${e.meta.confidence}]` : '';
      parts.push(`  ${nameOf(e.from)} --${e.type}--> ${nameOf(e.to)}${conf}`);
    }
  }
  return parts.join('\n');
}

export function formatSearch(query: string, results: GraphNode[], total: number): string {
  if (results.length === 0) {
    return `未找到匹配 "${query}" 的符号。可换更短的关键词或确认名字。`;
  }
  const lines = results.map((n) => `  • ${formatNode(n)}`);
  const more = total > results.length ? `\n（共 ${total} 条，已显示前 ${results.length} 条）` : '';
  return `搜索 "${query}" 命中 ${total} 条：\n${lines.join('\n')}${more}`;
}

export interface RepoEntry {
  repoName: string;
  hasGraph: boolean;
  totalNodes?: number;
  totalEdges?: number;
}

/** 影响面的一侧（上游 callers / 下游 callees），结构与 /api/why、/api/trace 响应兼容。 */
export interface ImpactSide {
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  message?: string;
  /** file 入参短名多命中时的候选路径（FILE_AMBIGUOUS 时下发） */
  candidates?: string[];
  /** file 入参时：聚合了文件内多少个实体符号 */
  sourceSymbols?: number;
}

/**
 * get_impact_scope 的输出：把上游影响面（谁调用了它）+ 下游依赖面（它调用了谁）合成一屏。
 * 纯图谱组合 trace_callers/trace_callees，无 LLM——"改一个方法/文件前先看波及范围"。
 * 两侧都 NOT_FOUND 才判未找到（单侧空是正常的：叶子节点无下游、入口无上游）；
 * file 短名多命中时返回候选列表交调用方消歧（绝不静默选一个）。
 */
export function formatImpactScope(
  symbol: string,
  upstream: ImpactSide,
  downstream: ImpactSide,
  limit = DEFAULT_ASK_OUTPUT_LIMIT,
): string {
  // 文件消歧：两侧同参数必然同判，取任一侧候选即可
  if (upstream.message === 'FILE_AMBIGUOUS' || downstream.message === 'FILE_AMBIGUOUS') {
    const candidates = upstream.candidates ?? downstream.candidates ?? [];
    return [
      `文件名 "${symbol}" 命中多个路径，请改用完整相对路径重试：`,
      ...candidates.map((c) => `  • ${c}`),
    ].join('\n');
  }
  const notFound = (m?: string): boolean => m === 'SYMBOL_NOT_FOUND' || m === 'FILE_NOT_FOUND';
  const upNotFound = notFound(upstream.message);
  const downNotFound = notFound(downstream.message);
  if (upNotFound && downNotFound) {
    return upstream.message === 'FILE_NOT_FOUND'
      ? `未找到文件 "${symbol}"。请确认相对路径（可用 get_file_graph 验证，或用 search_symbols 找到符号后看其所在文件）。`
      : `未找到符号 "${symbol}"。先用 search_symbols 确认名字。`;
  }
  const isFile = upstream.sourceSymbols !== undefined || downstream.sourceSymbols !== undefined;
  const subject = isFile
    ? `文件 "${symbol}"（聚合 ${upstream.sourceSymbols ?? downstream.sourceSymbols} 个符号，仅跨文件影响）`
    : `符号 "${symbol}"`;
  const sections = [
    `${subject} 的影响面评估（改动前先看）：`,
    '',
    `▲ 上游影响面（谁调用了它 = 改动会波及谁，深度 ${upstream.depth}）：`,
    upNotFound || upstream.nodes.length === 0
      ? '  （无已知调用方——改动的外部波及面较小）'
      : formatGraph(upstream.nodes, upstream.edges),
    '',
    `▼ 下游依赖面（它调用了谁 = 改动依赖什么，深度 ${downstream.depth}）：`,
    downNotFound || downstream.nodes.length === 0
      ? '  （无已知下游依赖）'
      : formatGraph(downstream.nodes, downstream.edges),
  ];
  return clampText(sections.join('\n'), limit);
}

export function formatRepoStatus(currentRepo: string | null, repos: RepoEntry[]): string {
  const header = currentRepo
    ? `当前加载仓库：${currentRepo}`
    : '当前未加载任何仓库（请在 Web 界面选中一个项目）';
  const lines = repos.map((r) => {
    const cur = r.repoName === currentRepo ? '→ ' : '  ';
    const stat = r.hasGraph ? `${r.totalNodes ?? '?'} 节点 / ${r.totalEdges ?? '?'} 边` : '未构建';
    return `${cur}${r.repoName} (${stat})`;
  });
  const body = lines.length ? `\n可用仓库：\n${lines.join('\n')}` : '';
  return `${header}${body}`;
}

const DEFAULT_ASK_OUTPUT_LIMIT = 8000;
/** 单条代码证据的展示上限：一行 minified/生成代码可达数万字符，不钳会独占整个输出预算 */
const EVIDENCE_CODE_LIMIT = 200;

/**
 * 截断到 limit 以内（含省略标记——结果总长绝不超过声明上限，review 修复）。
 * 切点若落在代理对高位上回退一位，防止劈开 emoji 产出落单代理项
 * （严格 JSON 重编码的非 JS 消费端会直接报错，apps/api 侧修过同款问题）。
 */
export function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // 用"全文长度"的位数预留标记额度（≥ 实际省略数的位数），保证总长上界成立
  const markerReserve = `\n...（已省略 ${text.length} 字）`.length;
  let cut = Math.max(0, limit - markerReserve);
  const cc = text.charCodeAt(cut - 1);
  if (cut > 0 && cc >= 0xd800 && cc <= 0xdbff) cut--;
  return `${text.slice(0, cut)}\n...（已省略 ${text.length - cut} 字）`;
}

function formatEvidence(evidence: Evidence[], limit = 10): string[] {
  if (evidence.length === 0) return ['（无代码证据）'];
  const shown = evidence.slice(0, limit).map((item) =>
    `  • ${item.file}:${item.line} [${item.label}] ${clampText(item.code.trim(), EVIDENCE_CODE_LIMIT)}`,
  );
  if (evidence.length > limit) {
    shown.push(`  ...（另有 ${evidence.length - limit} 条代码证据已省略）`);
  }
  return shown;
}

function formatDocEvidence(docEvidence: DocEvidence[] | undefined, limit = 4): string[] {
  if (!docEvidence || docEvidence.length === 0) return [];
  const lines = docEvidence.slice(0, limit).map((item) => {
    const section = item.section ? ` / ${item.section}` : '';
    const snippet = item.snippet.replace(/\s+/g, ' ').trim();
    return `  • ${item.title}${section} (${item.source})：${clampText(snippet, 180)}`;
  });
  if (docEvidence.length > limit) {
    lines.push(`  ...（另有 ${docEvidence.length - limit} 条文档证据已省略）`);
  }
  return lines;
}

function formatGraphSummary(response: AskResponse): string[] {
  const nodes = response.graph?.nodes ?? [];
  const edges = response.graph?.edges ?? [];
  const lines = [`节点 ${nodes.length} 个 / 关系 ${edges.length} 条`];
  const nodePreview = nodes.slice(0, 8).map((node) => `  • ${formatNode(node)}`);
  if (nodePreview.length > 0) lines.push(...nodePreview);
  if (nodes.length > nodePreview.length) {
    lines.push(`  ...（另有 ${nodes.length - nodePreview.length} 个节点已省略）`);
  }
  return lines;
}

export function formatAskResponse(
  question: string,
  response: AskResponse,
  opts: {
    limit?: number;
    /** 调用方请求复用的会话 id：与响应不一致时显式提示（静默 fork 会让多轮悄悄失忆，review 修复） */
    requestedConversationId?: string;
  } = {},
): string {
  const limit = opts.limit ?? DEFAULT_ASK_OUTPUT_LIMIT;
  const confidence = Number.isFinite(response.confidence) ? response.confidence.toFixed(2) : String(response.confidence);
  const sections: string[] = [
    `问题：${question}`,
    // 仓库标识（review 修复）：分析服务的"当前仓库"随 Web 端切换而变，
    // 不标注的话切库后消费端会拿另一个仓库的结论继续干活而毫无察觉
    ...(response.repoName ? [`仓库：${response.repoName}`] : []),
    `意图：${response.intent}，置信度：${confidence}`,
  ];

  if (response.conversationId) {
    sections.push(`会话：${response.conversationId}`);
    if (opts.requestedConversationId && response.conversationId !== opts.requestedConversationId) {
      sections.push(
        `⚠️ 请求复用的会话 ${opts.requestedConversationId} 不存在或不属于当前项目，本轮已新开会话（历史上下文为空）。后续追问请改用上面的新会话 id。`,
      );
    }
  }

  // 紧凑成本摘要（§4.5）：放头部，长回答被 clamp 也砍不到
  sections.push(...formatUsageLine(response.tokenUsageSummary));

  sections.push(
    '',
    '回答：',
    clampText(response.answer.trim() || '（空回答）', 2600),
    '',
    `代码证据（${response.evidence.length}）：`,
    ...formatEvidence(response.evidence),
  );

  const docs = formatDocEvidence(response.docEvidence);
  if (docs.length > 0) {
    sections.push('', `文档证据（${response.docEvidence!.length}）：`, ...docs);
  }

  sections.push('', '图谱摘要：', ...formatGraphSummary(response));

  if (response.followUp.length > 0) {
    sections.push('', '建议追问：', ...response.followUp.slice(0, 3).map((item) => `  • ${item}`));
  }

  return clampText(sections.join('\n'), limit);
}

/** 相关文件 / 接口 / 修改点等列表的通用"显示前 N + 已省略 M 条"渲染。 */
function formatCappedList<T>(items: T[], cap: number, render: (item: T) => string, noun: string): string[] {
  const shown = items.slice(0, cap).map((it) => `  • ${render(it)}`);
  if (items.length > cap) shown.push(`  ...（另有 ${items.length - cap} ${noun}已省略）`);
  return shown;
}

const fileLoc = (file?: string, line?: number): string => (file ? `${file}${line ? `:${line}` : ''}` : '');

/**
 * 格式化 AnalysisPacket（prepare_fix_context 的输出）。
 * 与 formatAskResponse 同款：分段拼装 + clampText 收口（总长 ≤ 8k，超预算段落带"已省略 N 条"）。
 * tier-3 字段（疑似修改点/验证建议/风险点）显式标注出处——启发式 vs LLM 判断字段的 v1 降级，
 * 让消费端知道哪些能直接信、哪些要自己核对（不制造"看起来结构化实则空话"的错觉）。
 */
export function formatAnalysisPacket(packet: AnalysisPacket, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? DEFAULT_ASK_OUTPUT_LIMIT;
  const sections: string[] = [
    `问题：${packet.question}`,
    ...(packet.repoName ? [`仓库：${packet.repoName}`] : []),
  ];

  // 入口（"从哪看起 / 从哪改"的锚）
  if (packet.entry) {
    const sym = packet.entry.symbol ? `（${packet.entry.symbol}）` : '';
    sections.push('', '入口：', `  ${fileLoc(packet.entry.file, packet.entry.line)}${sym} —— ${packet.entry.reason}`);
  } else {
    sections.push('', '入口：未定位到明确入口（换更具体的页面/组件名重试，或先用 search_symbols 确认符号）');
  }

  sections.push('', '结论：', clampText(packet.answer.trim() || '（空回答）', 2000));

  if (packet.flowSteps.length > 0) {
    const shown = packet.flowSteps.slice(0, 8).map((s, i) => {
      const loc = s.file ? ` [${fileLoc(s.file, s.line)}]` : '';
      return `  ${i + 1}. ${s.title}${loc}`;
    });
    if (packet.flowSteps.length > 8) shown.push(`  ...（另有 ${packet.flowSteps.length - 8} 步已省略）`);
    sections.push('', '关键流程：', ...shown);
  }

  if (packet.relatedFiles.length > 0) {
    sections.push('', `相关文件（${packet.relatedFiles.length}）：`, ...formatCappedList(packet.relatedFiles, 12, (f) => f, '个文件'));
  }

  if (packet.apiCalls.length > 0) {
    sections.push(
      '',
      `接口调用（${packet.apiCalls.length}）：`,
      ...formatCappedList(packet.apiCalls, 10, (a) => `${(a.method ?? '').toUpperCase()} ${a.endpoint ?? ''}${a.file ? ` (${fileLoc(a.file, a.line)})` : ''}`.replace(/\s+/g, ' ').trim(), '条接口'),
    );
  }

  // tier-3：疑似修改点——标注来源（LLM 判断 vs 启发式），消费端据此定信任度
  if (packet.suggestedEditLocations.length > 0) {
    sections.push(
      '',
      packet.sources.suggestedEdits === 'llm'
        ? '疑似修改点（LLM 基于材料判断，启发式补位，请核对行号）：'
        : '疑似修改点（基于入口+证据的启发式，非 LLM 判断，请核对）：',
      ...packet.suggestedEditLocations.map((s) => `  • ${fileLoc(s.file, s.line)} —— ${s.reason}`),
    );
  }

  // tier-3：验证建议
  if (packet.verificationHints.length > 0) {
    sections.push(
      '',
      packet.sources.verificationHints === 'llm' ? '验证建议（LLM 基于材料判断）：' : '验证建议（基于接口/入口的启发式）：',
      ...packet.verificationHints.map((h) => `  • ${h}`),
    );
  }

  // tier-3：风险点——只来自 LLM 小节（fix_context prompt 契约）；无小节诚实留缺，不硬凑
  sections.push(
    '',
    '风险点：',
    packet.riskPoints.length > 0
      ? packet.riskPoints.map((r) => `  • ${r}`).join('\n')
      : '  （无 LLM 风险点输出——可能走了非 LLM 回答路径或模型未按格式输出小节；规则不做硬凑）',
  );

  sections.push('', `代码证据（${packet.evidence.length}）：`, ...formatEvidence(packet.evidence));

  return clampText(sections.join('\n'), limit);
}

// ============================================================
// propose_patch（P2-G · 写侧第一刀）响应格式化
// /api/propose-patch 返回 200 + 判别式 body：ok=true 带提案，ok=false 带 reason。
// 类型在此本地声明（与 API 侧 PatchProposal 结构对齐）；前端接入时再考虑提到 shared-types。
// ============================================================

export interface ProposalFileView {
  file: string;
  baselineSha256: string;
  reason: string;
}

export interface ProposalView {
  proposalId: string;
  repoName: string;
  question: string;
  unifiedDiff: string;
  files: ProposalFileView[];
  verifyCommands: string[];
  validatedAt: string;
}

export type ProposePatchResponse = (
  | { ok: true; proposal: ProposalView; attempts?: number; note?: string }
  | { ok: false; reason: string; detail?: string; attempts?: number }
) & {
  /** 成本追踪（§4.5）：成功与业务失败都带——打不上的 diff 也是花过钱的 */
  turnId?: string;
  tokenUsageSummary?: TurnUsageSummary;
};

function formatProposalFailure(reason: string, detail?: string, attempts?: number): string {
  const attemptStr = attempts ? `（尝试 ${attempts} 次）` : '';
  const d = detail ? `：${detail}` : '';
  switch (reason) {
    case 'PATCH_NOT_APPLICABLE':
      return `未能生成可干净应用的补丁${attemptStr}${d}。\n建议：用 prepare_fix_context 重新定位更精确的目标文件，或把诉求写得更具体。`;
    case 'NO_CHANGE':
      return `分析未产生任何改动${d}。可能诉求已满足，或目标文件选得不对。`;
    case 'LLM_UNAVAILABLE':
      return `LLM 不可用${d}。请检查分析服务的 LLM 配置。`;
    case 'NO_REPO':
      return `未加载分析仓库${d}。请先在 Web 界面选中一个项目。`;
    case 'INVALID_INPUT':
      return `目标文件无效${d}。只允许修改仓库内已存在的文本文件（相对路径）。`;
    default:
      return `提案生成失败（${reason}）${d}。`;
  }
}

/**
 * 格式化补丁提案。成功时展示 diff + 基线 + 验证命令，并显式声明"只读提案、需人工审批"；
 * 失败时把 reason 翻成可行动的中文指引（"打不上"是正常负结果，不是错误）。
 */
export function formatProposal(data: ProposePatchResponse, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? DEFAULT_ASK_OUTPUT_LIMIT;
  if (!data.ok) {
    // 失败也渲染成本：业务失败（打不上的 diff）同样真实花了 LLM 的钱
    return [formatProposalFailure(data.reason, data.detail, data.attempts), ...formatUsageLine(data.tokenUsageSummary)].join('\n');
  }
  const p = data.proposal;
  const sections: string[] = [
    '✅ 已生成可应用的修改提案（已通过 git apply --check；未改动仓库任何文件）',
    `仓库：${p.repoName}    提案 id：${p.proposalId}`,
    `诉求：${p.question}`,
    // 成本放头部：clampText 保头弃尾，diff 很大时也砍不到它
    ...formatUsageLine(data.tokenUsageSummary),
    '',
    `涉及文件（${p.files.length}）：`,
    ...p.files.map(
      (f) => `  • ${f.file}  [基线 ${f.baselineSha256.slice(0, 12)}…]${f.reason ? ` —— ${f.reason}` : ''}`,
    ),
    '',
    '统一 diff：',
    '```diff',
    p.unifiedDiff.replace(/\n+$/, ''),
    '```',
  ];
  if (p.verifyCommands.length > 0) {
    sections.push('', '验证命令：', ...p.verifyCommands.map((c) => `  $ ${c}`));
  }
  sections.push('', '⚠️ 这是【只读提案】，尚未应用。应用需人工审批（本工具不落盘）。');
  return clampText(sections.join('\n'), limit);
}
