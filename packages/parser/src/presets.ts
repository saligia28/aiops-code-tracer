import type { ProjectFramework, LanguageParserId } from '@aiops/shared-types';

export interface LanguagePreset {
  parsers: LanguageParserId[];
  /**
   * 默认扫描目录。在此（Task 1.5）定义，由 `buildRepoConfig` 在 Task 1.8 接线时消费：
   * 用户未显式指定 scanPaths 时回落到这里。当前 `buildRepoConfig` 仅消费 parsers / exclude。
   */
  scanPaths: string[];
  exclude: string[];
}

/** 未单列的 framework（vue2/vue3/react/typescript/javascript 等）一律回落到 TS 解析器 */
const DEFAULT_PRESET: LanguagePreset = { parsers: ['typescript'], scanPaths: ['src'], exclude: [] };

const PRESETS: Partial<Record<ProjectFramework, LanguagePreset>> = {
  java: { parsers: ['java'], scanPaths: ['src/main/java'], exclude: ['src/test/**'] },
};

export function presetFor(fw: ProjectFramework): LanguagePreset {
  return PRESETS[fw] ?? DEFAULT_PRESET;
}
