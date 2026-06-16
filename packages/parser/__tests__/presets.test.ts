import { describe, it, expect } from 'vitest';
import { presetFor } from '../src/presets.js';

describe('presetFor', () => {
  it('java preset (multi-module friendly: whole-repo scan, exclude target/test)', () => {
    const p = presetFor('java');
    expect(p.parsers).toContain('java');
    // 整仓扫描，覆盖单模块(src/main/java)与多模块(<module>/src/main/java)布局
    expect(p.scanPaths).toEqual(['.']);
    expect(p.exclude).toContain('**/target/**');
    expect(p.exclude).toContain('**/src/test/**');
  });

  it('falls back to typescript parser for vue3', () => {
    expect(presetFor('vue3').parsers).toEqual(['typescript']);
  });
});
