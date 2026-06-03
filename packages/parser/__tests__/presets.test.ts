import { describe, it, expect } from 'vitest';
import { presetFor } from '../src/presets.js';

describe('presetFor', () => {
  it('java preset', () => {
    const p = presetFor('java');
    expect(p.parsers).toContain('java');
    expect(p.scanPaths).toEqual(['src/main/java']);
    expect(p.exclude).toContain('src/test/**');
  });

  it('falls back to typescript parser for vue3', () => {
    expect(presetFor('vue3').parsers).toEqual(['typescript']);
  });
});
