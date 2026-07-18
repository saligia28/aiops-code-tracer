import type { ToolDescriptor } from './types.js';
import { searchSymbols } from './searchSymbols.js';
import { traceCallees } from './traceCallees.js';
import { traceCallers } from './traceCallers.js';
import { getSymbol } from './getSymbol.js';
import { getFileGraph } from './getFileGraph.js';
import { repoStatus } from './repoStatus.js';
import { explainCodeLogic } from './explainCodeLogic.js';

export const allTools: ToolDescriptor[] = [
  repoStatus,
  explainCodeLogic,
  searchSymbols,
  getSymbol,
  traceCallees,
  traceCallers,
  getFileGraph,
];
