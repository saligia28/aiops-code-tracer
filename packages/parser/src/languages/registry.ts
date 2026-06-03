import type { LanguageParserId } from '@aiops/shared-types';
import type { LanguageParser } from './types.js';
import { TypeScriptLanguageParser } from './typescript/index.js';

export const DEFAULT_PARSER_IDS: readonly LanguageParserId[] = ['typescript'];

function pendingParserMethod(parserId: LanguageParserId): never {
  throw new Error(`Language parser "${parserId}" is registered but not implemented yet`);
}

const JavaLanguageParser: LanguageParser = {
  id: 'java',
  extensions: ['.java'],
  parseFile: () => pendingParserMethod('java'),
  resolve: () => pendingParserMethod('java'),
};

const PARSERS_BY_ID: ReadonlyMap<LanguageParserId, LanguageParser> = new Map([
  [TypeScriptLanguageParser.id, TypeScriptLanguageParser],
  [JavaLanguageParser.id, JavaLanguageParser],
]);

function normalizeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function normalizeEnabledParsers(
  enabled?: readonly LanguageParserId[]
): LanguageParserId[] {
  const ids = enabled && enabled.length > 0 ? enabled : DEFAULT_PARSER_IDS;
  return Array.from(new Set(ids));
}

export function getEnabledParsers(
  enabled?: readonly LanguageParserId[]
): LanguageParser[] {
  return normalizeEnabledParsers(enabled)
    .map((id) => PARSERS_BY_ID.get(id))
    .filter((parser): parser is LanguageParser => parser !== undefined);
}

export function getParserForExtension(
  extension: string,
  enabled?: readonly LanguageParserId[]
): LanguageParser | undefined {
  const normalizedExtension = normalizeExtension(extension);
  return getEnabledParsers(enabled).find((parser) =>
    parser.extensions.some((parserExtension) => normalizeExtension(parserExtension) === normalizedExtension)
  );
}

export function scanExtensionsFor(enabled?: readonly LanguageParserId[]): string[] {
  return Array.from(
    new Set(
      getEnabledParsers(enabled).flatMap((parser) =>
        parser.extensions.map((extension) => normalizeExtension(extension))
      )
    )
  );
}
