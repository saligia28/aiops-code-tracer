// ============================================================
// 图谱访问 & 符号解析
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import {
  graphStore,
  symbolIndex,
} from '../../context.js';


export function resolveSymbolToNodeId(symbolName: string): string | null {
  if (symbolIndex?.symbols[symbolName]) {
    const locations = symbolIndex.symbols[symbolName];
    const fnLoc = locations.find(l => l.type === 'function');
    if (fnLoc) return fnLoc.nodeId;
    const varLoc = locations.find(l => l.type === 'variable');
    if (varLoc) return varLoc.nodeId;
    return locations[0].nodeId;
  }

  if (graphStore) {
    const results = graphStore.searchByName(symbolName);
    const exact = results.find(n => n.name === symbolName);
    if (exact) return exact.id;
    if (results.length > 0) return results[0].id;
  }

  return null;
}


export function ensureGraph(reply: { code: (code: number) => { send: (data: unknown) => void } }): boolean {
  if (!graphStore) {
    reply.code(503).send({
      error: 'GRAPH_NOT_LOADED',
      message: '图谱未加载，请先运行索引构建',
    });
    return false;
  }
  return true;
}
