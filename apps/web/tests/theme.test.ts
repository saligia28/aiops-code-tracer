import { describe, expect, it } from 'vitest';
import { nextTheme, resolveInitialTheme } from '../src/lib/theme';

describe('theme', () => {
  it('toggles light and dark', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });

  it('prefers a valid stored value', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
  });

  it('falls back to system preference', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme('invalid', false)).toBe('light');
  });
});
