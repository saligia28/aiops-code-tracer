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
 * 解析 Vue SFC 文件，提取 script 和 template 块
 */
export function parseVueSfc(filePath: string): SfcParseResult {
  const source = fs.readFileSync(filePath, 'utf-8');
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
