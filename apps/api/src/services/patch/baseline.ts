import fs from 'node:fs';
import crypto from 'node:crypto';

// ============================================================
// 基线哈希（防"基于旧内容改新文件"）
// 图谱 / prepare_fix_context 都是"上次索引时"快照，真实文件可能已变。提案携带每个
// 目标文件的基线哈希，落盘前（审批门）先校验文件未变——把"可能猜错"挡在写盘之外。
// ============================================================

/**
 * 对原始字节做 sha256（十六进制）。
 * 关键：绝不做换行归一化——CRLF/LF、末尾空行差异都必须被视为"文件已变"，
 * 否则一个看似无害的换行改动会让 diff 打不上却通过基线校验。
 */
export function sha256OfBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** 读取文件原始字节算 sha256；文件不存在 / 不可读 / 是目录时返回 null（交上层判为基线缺失）。 */
export function sha256OfFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    return sha256OfBytes(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}
