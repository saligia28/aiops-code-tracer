import type { GraphNode, GraphEdge } from '@aiops/shared-types';

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
