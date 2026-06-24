// ============================================================
// 接口端点提取 & 接口清单
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import type {
  GraphNode,
  Evidence,
  AskResponse,
} from '@aiops/shared-types';
import {
  currentRepoPath,
  type PageAnchor,
  type EndpointHit,
} from '../../context.js';
import { toRepoRelative, listFilesRecursively } from './codeScan.js';
import { findRelevantNodes } from './recall.js';
import { pickTraceGraph } from './graphPath.js';


function extractEndpointHitsFromFile(absPath: string): EndpointHit[] {
  const hits: EndpointHit[] = [];
  if (!fs.existsSync(absPath) || !currentRepoPath) return hits;

  const rel = toRepoRelative(absPath);
  const content = fs.readFileSync(absPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const endpointRegex = /request\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(endpointRegex);
    if (!m) continue;
    let hint: string | undefined;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prev = lines[j].trim();
      if (!prev) continue;
      if (prev.startsWith('//')) {
        hint = prev.replace(/^\/\//, '').trim();
      }
      break;
    }
    hits.push({
      method: m[1].toUpperCase(),
      endpoint: m[2],
      file: rel,
      line: i + 1,
      hint,
    });
  }
  return hits;
}


export function collectPageEndpointHits(anchor: PageAnchor): EndpointHit[] {
  if (!currentRepoPath) return [];
  const componentAbs = path.join(currentRepoPath, anchor.componentFile);
  const baseDir = path.dirname(componentAbs);
  if (!fs.existsSync(baseDir)) return [];

  const candidates = listFilesRecursively(baseDir, 4).filter((absPath) => /\.(vue|ts|js|tsx|jsx)$/i.test(absPath));
  const allHits: EndpointHit[] = [];
  for (const absPath of candidates) {
    allHits.push(...extractEndpointHitsFromFile(absPath));
  }

  const dedup = new Map<string, EndpointHit>();
  for (const hit of allHits) {
    const key = `${hit.method}|${hit.endpoint}|${hit.file}`;
    if (!dedup.has(key)) {
      dedup.set(key, hit);
    }
  }

  return Array.from(dedup.values()).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}


function buildApiListAnswer(anchor: PageAnchor, hits: EndpointHit[]): string {
  const top = hits.slice(0, 12);
  const lines = top.map((hit, idx) => {
    const hint = hit.hint ? `（${hit.hint}）` : '';
    return `${idx + 1}. ${hit.method} ${hit.endpoint}${hint}`;
  }).join('\n');

  return [
    `结论：${anchor.title} 页面当前共定位到 ${hits.length} 个后端接口调用。`,
    `实现说明：页面入口在 ${anchor.componentFile}，接口主要分布在同目录的 API/组件文件中。`,
    '',
    '接口清单（去重后）：',
    lines,
  ].join('\n');
}


export function buildApiListResponse(question: string, anchor: PageAnchor, hits: EndpointHit[]): AskResponse {
  const evidence: Evidence[] = hits.slice(0, 12).map((hit) => ({
    file: hit.file,
    line: hit.line,
    code: `${hit.method} ${hit.endpoint}`,
    label: `apiCall: ${hit.method} ${hit.endpoint}`,
  }));

  const scopeNodes = findRelevantNodes(`${anchor.title} ${anchor.componentFile}`, 30).filter((node) =>
    node.filePath.startsWith(path.dirname(anchor.componentFile))
  );
  const startNode = scopeNodes[0];
  const graph = startNode ? pickTraceGraph(startNode, 'API_USAGE', question) : { nodes: [], edges: [] };

  return {
    answer: buildApiListAnswer(anchor, hits),
    evidence,
    graph,
    intent: 'API_USAGE',
    confidence: 0.9,
    followUp: [
      `"${anchor.title}"里哪个接口是列表查询主接口？`,
      '这些接口分别由哪个按钮或操作触发？',
      `"${anchor.title}"里接口参数（分页/筛选）是怎么组装的？`,
    ],
  };
}


export function tryAnalyzeApiPassThrough(node: GraphNode): { endpoint?: string; paramName?: string } | null {
  if (!currentRepoPath || node.type !== 'function') return null;

  const absPath = path.join(currentRepoPath, node.filePath);
  if (!fs.existsSync(absPath)) return null;

  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    const requestCallMatch = content.match(
      /request\.\w+(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z_$][\w$]*)/m
    );
    if (!requestCallMatch) return null;
    return {
      endpoint: requestCallMatch[1],
      paramName: requestCallMatch[2],
    };
  } catch {
    return null;
  }
}
