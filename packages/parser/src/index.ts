// scanner
export { collectFiles } from './scanner/fileCollector.js';
export { parseVueSfc } from './scanner/vueSfcParser.js';
export type { SfcParseResult } from './scanner/vueSfcParser.js';
export { resolveAliasPath, resolveRelativePath } from './scanner/pathResolver.js';

// extractors
export {
  extractImports,
  extractFunctions,
  extractCalls,
  extractAssignments,
  getLoc,
} from './extractors/index.js';
export type { FileParseResult, UnresolvedRef, ExtractorContext } from './extractors/index.js';

// graph builder
export { parseFile, resolvePhase, buildGraph } from './graphBuilder.js';
export type { BuildResult, BuildStats } from './graphBuilder.js';

// symbol index
export {
  buildSymbolIndex,
  buildFileIndex,
  buildApiIndex,
  buildRouteIndex,
} from './symbolIndex.js';

// 跨语言桥
export { buildCrossLanguageEdges } from './crossLanguage.js';
export type {
  SymbolIndex,
  SymbolLocation,
  FileIndex,
  ApiIndex,
  ApiCallLocation,
  ServerRouteLocation,
  RouteIndex,
  RouteEntry,
} from './symbolIndex.js';

// language parser registry
export {
  DEFAULT_PARSER_IDS,
  getEnabledParsers,
  getParserForExtension,
  scanExtensionsFor,
} from './languages/registry.js';
export type { LanguageParser, ParserContext, ResolveResult } from './languages/types.js';

// framework → preset mapping
export { presetFor } from './presets.js';
export type { LanguagePreset } from './presets.js';

/**
 * Parser 产物版本戳：解析行为变化（会影响已建图谱正确性的修复/变更）时递增。
 * indexService 把它写进 meta.json；loadGraph 发现不匹配会告警提示重建——
 * 否则像 Vue SFC 行号偏移这类修复后，旧图会静默带着错数据继续服务。
 * 2026.07.14: Vue SFC script 块行号偏移修复（loc 映射回文件行号）。
 */
export const PARSER_VERSION = '2026.07.14';
