import { parse as parseSfc } from '@vue/compiler-sfc';
import fs from 'fs';

export interface SfcParseResult {
  scriptContent: string | null;
  scriptLang: string | null;
  scriptSetup: boolean;
  templateContent: string | null;
  filePath: string;
  /**
   * script 块内容在原始 .vue 文件中的起始行（1-based，= compiler-sfc 的 block.loc.start.line）。
   * extractor 对 scriptContent 计算的行号是块内行号，映射回文件行号需 +(scriptStartLine - 1)。
   * 丢掉这个偏移会让所有 SFC 符号的 file:line 引用整体偏移 template 的长度（评测 L2 抓到的真 bug）。
   */
  scriptStartLine: number;
}

/**
 * 从 SFC 源码文本提取 script 和 template 块（content 版）
 *
 * 供语言无关编排层在已读取文件内容后调用，不触碰磁盘。
 */
export function parseVueSfcContent(source: string, filePath: string): SfcParseResult {
  const { descriptor } = parseSfc(source, { filename: filePath });

  const script = descriptor.scriptSetup || descriptor.script;

  return {
    scriptContent: script?.content ?? null,
    scriptLang: script?.lang ?? null,
    scriptSetup: !!descriptor.scriptSetup,
    templateContent: descriptor.template?.content ?? null,
    filePath,
    scriptStartLine: script?.loc.start.line ?? 1,
  };
}

/**
 * 解析 Vue SFC 文件，提取 script 和 template 块（读盘版，向后兼容）
 */
export function parseVueSfc(filePath: string): SfcParseResult {
  const source = fs.readFileSync(filePath, 'utf-8');
  return parseVueSfcContent(source, filePath);
}
