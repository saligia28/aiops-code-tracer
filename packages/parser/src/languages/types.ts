import type { GraphEdge, LanguageParserId, RepoConfig } from '@aiops/shared-types';
import type { FileParseResult } from '../extractors/types.js';

export interface ParserContext {
  config: RepoConfig;
}

export interface ResolveResult {
  resolvedEdges: GraphEdge[];
  unresolvedCount: number;
  totalRefs: number;
}

export interface LanguageParser {
  id: LanguageParserId;
  extensions: string[];
  parseFile(
    filePath: string,
    content: string,
    ctx: ParserContext
  ): FileParseResult | Promise<FileParseResult>;
  resolve(
    ownResults: FileParseResult[],
    allResults: FileParseResult[],
    ctx: ParserContext
  ): ResolveResult | Promise<ResolveResult>;
}
