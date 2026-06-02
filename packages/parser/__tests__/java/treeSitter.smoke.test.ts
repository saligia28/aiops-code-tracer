import { describe, it, expect } from 'vitest';
import { loadJavaParser } from '../../src/languages/java/treeSitter.js';

describe('java tree-sitter smoke', () => {
  it('parses a trivial class', async () => {
    const parser = await loadJavaParser();
    const tree = parser.parse('package a; public class X { void m() {} }');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.hasError).toBe(false);
  });
});
