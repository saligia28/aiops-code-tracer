import { describe, expect, it } from 'vitest';
import {
  getEnabledParsers,
  getParserForExtension,
  scanExtensionsFor,
} from '../../src/languages/registry.js';

describe('language parser registry', () => {
  it('routes .java to java parser when java is enabled', () => {
    expect(getParserForExtension('.java', ['typescript', 'java'])?.id).toBe('java');
  });

  it('derives scan extensions from enabled parsers', () => {
    expect(scanExtensionsFor(['java']).sort()).toEqual(['.java']);
  });

  it('defaults empty parser config to typescript parser extensions', () => {
    expect(scanExtensionsFor([]).sort()).toEqual(['.js', '.jsx', '.ts', '.tsx', '.vue']);
  });

  it('does not route extensions for disabled parsers', () => {
    expect(getParserForExtension('.java', ['typescript'])).toBeUndefined();
    expect(getParserForExtension('TS', ['typescript'])?.id).toBe('typescript');
  });

  it('returns enabled parser definitions in config order without duplicates', () => {
    expect(getEnabledParsers(['java', 'typescript', 'java']).map((parser) => parser.id)).toEqual([
      'java',
      'typescript',
    ]);
  });
});
