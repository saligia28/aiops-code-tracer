import { parse as parseSfc } from '@vue/compiler-sfc';
import fs from 'fs';

export interface SfcParseResult {
  scriptContent: string | null;
  scriptLang: string | null;
  scriptSetup: boolean;
  templateContent: string | null;
  filePath: string;
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
  };
}

/**
 * 解析 Vue SFC 文件，提取 script 和 template 块（读盘版，向后兼容）
 */
export function parseVueSfc(filePath: string): SfcParseResult {
  const source = fs.readFileSync(filePath, 'utf-8');
  return parseVueSfcContent(source, filePath);
}
