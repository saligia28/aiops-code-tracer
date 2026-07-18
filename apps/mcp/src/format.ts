import type { AskResponse, DocEvidence, Evidence, GraphEdge, GraphNode } from '@aiops/shared-types';

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

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...（已省略 ${text.length - limit} 字）`;
}

function formatEvidence(evidence: Evidence[], limit = 10): string[] {
  if (evidence.length === 0) return ['（无代码证据）'];
  const shown = evidence.slice(0, limit).map((item) =>
    `  • ${item.file}:${item.line} [${item.label}] ${item.code.trim()}`,
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
