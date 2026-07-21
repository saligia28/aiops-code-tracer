import type { ToolDescriptor } from './types.js';
import { searchSymbols } from './searchSymbols.js';
import { traceCallees } from './traceCallees.js';
import { traceCallers } from './traceCallers.js';
import { getSymbol } from './getSymbol.js';
import { getFileGraph } from './getFileGraph.js';
import { repoStatus } from './repoStatus.js';
import { explainCodeLogic } from './explainCodeLogic.js';
import { prepareFixContext } from './prepareFixContext.js';
import { getImpactScope } from './getImpactScope.js';
import { proposePatch } from './proposePatch.js';

export const allTools: ToolDescriptor[] = [
  repoStatus,
  explainCodeLogic,
  prepareFixContext,
  getImpactScope,
  proposePatch,
  searchSymbols,
  getSymbol,
  traceCallees,
  traceCallers,
  getFileGraph,
];
