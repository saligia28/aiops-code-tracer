// 落单的 UTF-16 代理项：高位代理(D800-DBFF)后面不是低位代理，或低位代理(DC00-DFFF)前面不是高位代理。
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 把落单的 UTF-16 代理项替换为 U+FFFD，保证文本是合法 UTF-16、可被严格 JSON 解析器接受。
 *
 * 背景：工具结果/代码上下文里常含 📁/📄 等 emoji（星体面字符，由代理对表示）。按字符（码元）
 * 截断时可能把代理对劈成两半，留下半个。JS 的 JSON.parse 宽松、能接受，但 DeepSeek 等严格
 * 解析器会报 400 "unexpected end of hex escape: messages[N].content" 并拒绝整个请求。
 *
 * 注意：不依赖 String.prototype.toWellFormed（ES2024，超出当前 tsconfig lib），改用等价正则。
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(LONE_SURROGATE_RE, '�');
}
