/**
 * JavaLanguageParser — 组合 Pass1（单文件结构）+ Pass2（跨文件连边）。
 *
 * 注册在 languages/registry.ts；编排层（graphBuilder）按 .java 扩展名路由到此。
 */
import type { FileParseResult } from '../../extractors/types.js';
import type { LanguageParser, ParserContext, ResolveResult } from '../types.js';
import { runPass1 } from './pass1.js';
import { runPass2 } from './pass2.js';

export const JavaLanguageParser: LanguageParser = {
  id: 'java',
  extensions: ['.java'],
  parseFile(filePath: string, content: string, ctx: ParserContext): Promise<FileParseResult> {
    return runPass1(filePath, content, ctx);
  },
  resolve(
    ownResults: FileParseResult[],
    allResults: FileParseResult[],
    ctx: ParserContext
  ): ResolveResult {
    return runPass2(ownResults, allResults, ctx);
  },
};
