/**
 * 供应商 usage → 统一 `LlmTokenUsage`（成本追踪 · 阶段 1）。
 *
 * 两条纪律（设计文档 §9.5）：
 *   1. **不静默改写供应商数据**。字段自相矛盾时保留原值，只记 validationWarnings——
 *      改写会让"和账单对不上"这件事永远查不出来。
 *   2. 缺什么就标什么。缺缓存拆分 → 全按未命中算（成本上界）并标 estimated；
 *      整体没有 usage → missing，Token 和成本都留空，绝不用 0 冒充。
 */
import type { LlmTokenUsage, UsageSource, UsageValidationWarning } from '@aiops/shared-types';

/** OpenAI 兼容 + DeepSeek 扩展 + Ollama 三种形态的原始 usage */
export interface RawProviderUsage {
  // OpenAI 兼容
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // DeepSeek 上下文缓存
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  // 思考模型
  completion_tokens_details?: { reasoning_tokens?: number };
  reasoning_tokens?: number;
  // Ollama
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface NormalizedUsage {
  tokens: LlmTokenUsage;
  usageSource: UsageSource;
  validationWarnings: UsageValidationWarning[];
}

const MISSING: NormalizedUsage = { tokens: {}, usageSource: 'missing', validationWarnings: [] };

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * @param raw 供应商返回的 usage 对象；null/undefined/空对象都视为 missing
 */
export function normalizeProviderUsage(raw: RawProviderUsage | null | undefined): NormalizedUsage {
  if (!raw || typeof raw !== 'object') return MISSING;

  // Ollama 用的是另一套字段名
  const promptTokens = num(raw.prompt_tokens) ?? num(raw.prompt_eval_count);
  const completionTokens = num(raw.completion_tokens) ?? num(raw.eval_count);
  const reasoningTokens = num(raw.completion_tokens_details?.reasoning_tokens) ?? num(raw.reasoning_tokens);
  let cacheHitTokens = num(raw.prompt_cache_hit_tokens);
  let cacheMissTokens = num(raw.prompt_cache_miss_tokens);
  const totalTokens = num(raw.total_tokens);

  // 一个可用字段都没有 = 供应商没给 usage
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return MISSING;
  }

  const warnings: UsageValidationWarning[] = [];
  let usageSource: UsageSource = 'provider';

  const hasSplit = cacheHitTokens !== undefined || cacheMissTokens !== undefined;
  if (hasSplit) {
    // 只给了一半时补另一半（能补就补，补不了就留空）
    if (cacheHitTokens === undefined && promptTokens !== undefined && cacheMissTokens !== undefined) {
      cacheHitTokens = Math.max(0, promptTokens - cacheMissTokens);
    }
    if (cacheMissTokens === undefined && promptTokens !== undefined && cacheHitTokens !== undefined) {
      cacheMissTokens = Math.max(0, promptTokens - cacheHitTokens);
    }
    if (
      promptTokens !== undefined &&
      cacheHitTokens !== undefined &&
      cacheMissTokens !== undefined &&
      cacheHitTokens + cacheMissTokens !== promptTokens
    ) {
      warnings.push('prompt_cache_mismatch');
    }
  } else if (promptTokens !== undefined) {
    // 代理/非 DeepSeek 供应商不返回缓存拆分：全按未命中算，这是**成本上界**，标 estimated
    cacheHitTokens = 0;
    cacheMissTokens = promptTokens;
    usageSource = 'estimated';
  }

  if (
    totalTokens !== undefined &&
    promptTokens !== undefined &&
    completionTokens !== undefined &&
    promptTokens + completionTokens !== totalTokens
  ) {
    warnings.push('total_token_mismatch');
  }

  if (reasoningTokens !== undefined && completionTokens !== undefined && reasoningTokens > completionTokens) {
    warnings.push('reasoning_exceeds_completion');
  }

  const tokens: LlmTokenUsage = {};
  if (promptTokens !== undefined) tokens.promptTokens = promptTokens;
  if (cacheHitTokens !== undefined) tokens.cacheHitTokens = cacheHitTokens;
  if (cacheMissTokens !== undefined) tokens.cacheMissTokens = cacheMissTokens;
  if (completionTokens !== undefined) tokens.completionTokens = completionTokens;
  if (reasoningTokens !== undefined) tokens.reasoningTokens = reasoningTokens;
  // total 缺失时由 prompt+completion 推导（纯算术，不算 estimated）
  tokens.totalTokens = totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0);

  return { tokens, usageSource, validationWarnings: warnings };
}
