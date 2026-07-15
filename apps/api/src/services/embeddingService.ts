import type { FastifyBaseLogger } from 'fastify';
import {
  EMBEDDING_PROVIDER,
  EMBEDDING_API_KEY,
  EMBEDDING_TIMEOUT_MS,
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
} from '../context.js';
import { stripLoneSurrogates } from '../textSafety.js';

// ============================================================
// 文档证据通道 —— Embedding 服务骨架
// 仿 llmService.ts，走 OpenAI 兼容的 /embeddings 接口。
// 本文件只负责"把文本转成向量"，不涉及召回 / 证据组装。
// ============================================================

let _log: FastifyBaseLogger | undefined;

export function setEmbeddingServiceLogger(log: FastifyBaseLogger): void {
  _log = log;
}

export function getEmbeddingModel(): string {
  return DEFAULT_EMBEDDING_MODEL;
}

export function getEmbeddingBaseUrl(): string {
  return DEFAULT_EMBEDDING_BASE_URL;
}

/** 本地 / Ollama 不需要 key；其余 provider 需配置 EMBEDDING_API_KEY。 */
export function canUseEmbedding(): boolean {
  if (!DEFAULT_EMBEDDING_BASE_URL || !DEFAULT_EMBEDDING_MODEL) return false;
  if (EMBEDDING_PROVIDER === 'local' || EMBEDDING_PROVIDER === 'ollama') return true;
  return Boolean(EMBEDDING_API_KEY);
}

export function resolveEmbeddingsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/embeddings')) return base;
  if (base.endsWith('/v1')) return `${base}/embeddings`;
  if (base.endsWith('/v1/')) return `${base}embeddings`;
  return `${base}/embeddings`;
}

/**
 * 将一批文本转为向量。失败返回 null（调用方自行决定降级/跳过）。
 * 返回顺序与入参一致。
 * @param opts.timeoutMs 覆盖默认超时——构建期可以慢（默认 EMBEDDING_TIMEOUT_MS=30s），
 *        但「查询期内联调用」必须传一个短超时（如 2.5s），否则 embedding 后端挂起会拖垮问答主链路。
 */
export async function embedTexts(texts: string[], opts?: { timeoutMs?: number }): Promise<number[][] | null> {
  if (!canUseEmbedding()) return null;
  const inputs = texts.map((t) => stripLoneSurrogates(t));
  if (inputs.length === 0) return [];

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (EMBEDDING_API_KEY) {
    headers.authorization = `Bearer ${EMBEDDING_API_KEY}`;
  }

  const fallback = Number.isFinite(EMBEDDING_TIMEOUT_MS) && EMBEDDING_TIMEOUT_MS > 0 ? EMBEDDING_TIMEOUT_MS : 30000;
  const timeout = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(resolveEmbeddingsUrl(DEFAULT_EMBEDDING_BASE_URL), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: DEFAULT_EMBEDDING_MODEL,
        input: inputs,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`Embedding 调用失败: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const json = await resp.json() as {
      data?: Array<{ index?: number; embedding?: number[] }>;
    };
    const data = json.data ?? [];
    if (data.length === 0) return null;

    // 按 index 回填，确保与入参顺序对齐
    const ordered: number[][] = new Array(inputs.length);
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const idx = typeof item.index === 'number' ? item.index : i;
      if (Array.isArray(item.embedding)) {
        ordered[idx] = item.embedding;
      }
    }
    return ordered.every((vec) => Array.isArray(vec)) ? ordered : null;
  } catch (err) {
    _log?.warn(`Embedding 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 单条文本便捷封装。 */
export async function embedText(text: string, opts?: { timeoutMs?: number }): Promise<number[] | null> {
  const result = await embedTexts([text], opts);
  return result?.[0] ?? null;
}
