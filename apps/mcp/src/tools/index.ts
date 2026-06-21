import type { ToolDescriptor } from './types.js';
import { searchSymbols } from './searchSymbols.js';
import { traceCallees } from './traceCallees.js';
import { traceCallers } from './traceCallers.js';
import { getSymbol } from './getSymbol.js';
import { getFileGraph } from './getFileGraph.js';
import { repoStatus } from './repoStatus.js';

export const allTools: ToolDescriptor[] = [
  repoStatus,
  searchSymbols,
  getSymbol,
  traceCallees,
  traceCallers,
  getFileGraph,
];
