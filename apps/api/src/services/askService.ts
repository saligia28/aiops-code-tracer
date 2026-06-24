// askService.ts — 拆分后的聚合出口（barrel）。
// 实际实现位于 ./ask/*.ts，此处统一 re-export 以保持对外 import 路径不变。

export * from './ask/textUtils.js';
export * from './ask/codeScan.js';
export * from './ask/questionAnalysis.js';
export * from './ask/graphAccess.js';
export * from './ask/indexing.js';
export * from './ask/recall.js';
export * from './ask/componentScope.js';
export * from './ask/graphPath.js';
export * from './ask/endpoints.js';
export * from './ask/evidence.js';
export * from './ask/answer.js';
export * from './ask/evidencePlan.js';
