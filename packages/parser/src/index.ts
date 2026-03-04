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
export type {
  SymbolIndex,
  SymbolLocation,
  FileIndex,
  ApiIndex,
  ApiCallLocation,
  RouteIndex,
  RouteEntry,
} from './symbolIndex.js';
