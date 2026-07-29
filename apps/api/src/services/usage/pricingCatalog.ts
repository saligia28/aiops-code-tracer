/**
 * 价格目录（成本追踪 · 阶段 1）—— 把「provider + model + baseUrl」解析成一份价格快照。
 *
 * 设计约束（改动前请读设计文档 §9）：
 *   - 单位是 nano-CNY/token（1 CNY = 1e9 nano）。用整数是因为缓存命中价低到
 *     ¥0.02/百万 token，用浮点或"元"为单位会被舍成 0，成本直接消失。
 *   - 每次调用保存**快照**而不是引用目录：以后调价不重算历史金额。
 *   - 匹配不到单价时返回 null——Token 照记、金额留空，绝不套用别的模型价格假装有数。
 *   - 别名（deepseek-chat/reasoner）只在**官方 origin** 下才敢套官方价：换成代理或
 *     自建网关时，同一个模型名背后可能是完全不同的模型和价格。
 */
import type { LlmPricingSnapshot, LlmProvider, LlmTokenUsage, PricingMatchKind } from '@aiops/shared-types';

/** 价格目录版本：目录内容变了就要 +1，快照里存着它，方便事后追溯当时用的是哪版 */
export const PRICING_CATALOG_VERSION = '2026-07-29.1';
const SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const VERIFIED_AT = '2026-07-29';

/** 每百万 token 的人民币价（与官方计价页同单位，便于人工核对） */
interface CnyPerMillion {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
  supportsPromptCache: boolean;
}

/**
 * 内置目录。key 是 canonical model 名。
 * 官方计价页（2026-07-29 核验）：
 *   deepseek-v4-flash  命中 ¥0.02 / 未命中 ¥1 / 输出 ¥2
 *   deepseek-v4-pro    命中 ¥0.025 / 未命中 ¥3 / 输出 ¥6
 */
const BUILTIN: Record<string, CnyPerMillion> = {
  'deepseek-v4-flash': { inputCacheHit: 0.02, inputCacheMiss: 1, output: 2, supportsPromptCache: true },
  'deepseek-v4-pro': { inputCacheHit: 0.025, inputCacheMiss: 3, output: 6, supportsPromptCache: true },
};

/**
 * 官方弃用的旧模型名 → canonical。
 * 只有 provider=deepseek 且 origin 是官方域名时才生效（见 isOfficialDeepSeekOrigin）。
 */
const OFFICIAL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
};

const OFFICIAL_DEEPSEEK_HOST = 'api.deepseek.com';

/** 每百万元 → 每 token 的 nano-CNY 整数。¥1/M = 1000 nano/token */
function cnyPerMillionToNanoPerToken(cnyPerMillion: number): number {
  return Math.round(cnyPerMillion * 1000);
}

/**
 * baseUrl 是不是 DeepSeek 官方端点。
 *
 * 只看 scheme + host，忽略 path（`/v1`、`/beta`）、端口默认值、查询串、尾斜杠与大小写。
 * host 必须**整段相等**——用 endsWith('deepseek.com') 会把 api.deepseek.com.evil.tld 放进来。
 * 明文 http 一律视为被改写过的代理，不给官方价。
 */
export function isOfficialDeepSeekOrigin(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'https:') return false;
    return url.hostname.toLowerCase() === OFFICIAL_DEEPSEEK_HOST;
  } catch {
    return false;
  }
}

interface CatalogEntry extends CnyPerMillion {
  canonicalModel: string;
  matchKind: PricingMatchKind;
}

/** 解析 LLM_PRICING_CNY_JSON。非法配置只告警并忽略该条，绝不影响 LLM 调用 */
function readOverrides(log?: { warn(msg: string): void }): Record<string, CnyPerMillion> {
  const raw = (process.env.LLM_PRICING_CNY_JSON ?? '').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log?.warn('[pricing] LLM_PRICING_CNY_JSON 不是合法 JSON，已忽略全部自定义价格');
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log?.warn('[pricing] LLM_PRICING_CNY_JSON 顶层必须是对象，已忽略');
    return {};
  }

  const out: Record<string, CnyPerMillion> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = value as Partial<CnyPerMillion> | null;
    const nums = [v?.inputCacheHit, v?.inputCacheMiss, v?.output];
    const ok = v && nums.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
    if (!ok) {
      log?.warn(`[pricing] 自定义价格 "${model}" 字段非法（需 inputCacheHit/inputCacheMiss/output 非负数），已忽略该模型`);
      continue;
    }
    out[model] = {
      inputCacheHit: v!.inputCacheHit!,
      inputCacheMiss: v!.inputCacheMiss!,
      output: v!.output!,
      supportsPromptCache: v!.supportsPromptCache ?? false,
    };
  }
  return out;
}

/** 惰性缓存：env 只读一次（测试里可用 resetPricingCatalog 强制重读） */
let overridesCache: Record<string, CnyPerMillion> | null = null;

export function resetPricingCatalog(): void {
  overridesCache = null;
}

function overrides(log?: { warn(msg: string): void }): Record<string, CnyPerMillion> {
  if (overridesCache === null) overridesCache = readOverrides(log);
  return overridesCache;
}

/**
 * 找到该次调用适用的价格条目。优先级：
 *   1. 自定义覆盖（精确模型名）——允许用户覆盖内置价，也允许补充内置没有的模型
 *   2. 内置精确模型名
 *   3. 官方别名（仅 provider=deepseek + 官方 origin）
 */
function lookup(
  provider: LlmProvider,
  model: string,
  baseUrl: string | undefined,
  log?: { warn(msg: string): void },
): CatalogEntry | null {
  const name = model.trim();
  if (!name) return null;

  const custom = overrides(log)[name];
  if (custom) return { ...custom, canonicalModel: name, matchKind: 'custom_override' };

  const builtin = BUILTIN[name];
  if (builtin) return { ...builtin, canonicalModel: name, matchKind: 'exact_model' };

  const aliasTarget = OFFICIAL_ALIASES[name];
  if (aliasTarget && provider === 'deepseek' && isOfficialDeepSeekOrigin(baseUrl)) {
    const target = BUILTIN[aliasTarget];
    if (target) return { ...target, canonicalModel: aliasTarget, matchKind: 'official_alias' };
  }

  return null;
}

/**
 * 解析价格快照。匹配不到返回 null（调用方据此把成本字段留空 + unknownPricingCalls+1）。
 */
export function resolvePricing(
  provider: LlmProvider,
  model: string,
  baseUrl?: string,
  log?: { warn(msg: string): void },
): LlmPricingSnapshot | null {
  const entry = lookup(provider, model, baseUrl, log);
  if (!entry) return null;
  return {
    currency: 'CNY',
    canonicalModel: entry.canonicalModel,
    inputCacheHitNanoCnyPerToken: cnyPerMillionToNanoPerToken(entry.inputCacheHit),
    inputCacheMissNanoCnyPerToken: cnyPerMillionToNanoPerToken(entry.inputCacheMiss),
    outputNanoCnyPerToken: cnyPerMillionToNanoPerToken(entry.output),
    matchKind: entry.matchKind,
    supportsPromptCache: entry.supportsPromptCache,
    catalogVersion: PRICING_CATALOG_VERSION,
    sourceUrl: SOURCE_URL,
    verifiedAt: VERIFIED_AT,
  };
}

/**
 * canonical 名（不含价格）——事件表要存它，方便按模型聚合。
 * 没匹配到价格时退回原始模型名，不留空。
 */
export function canonicalizeModel(provider: LlmProvider, model: string, baseUrl?: string): string {
  return lookup(provider, model, baseUrl)?.canonicalModel ?? model.trim();
}

export interface ComputedCost {
  cacheHitCostNanoCny: number;
  cacheMissCostNanoCny: number;
  outputCostNanoCny: number;
  totalCostNanoCny: number;
}

/**
 * 按快照算钱。
 * reasoningTokens 是 completionTokens 的子集，**不单独计费**——重复计会凭空多算一份输出钱。
 */
export function computeCost(tokens: LlmTokenUsage, pricing: LlmPricingSnapshot): ComputedCost {
  const hit = tokens.cacheHitTokens ?? 0;
  const miss = tokens.cacheMissTokens ?? 0;
  const out = tokens.completionTokens ?? 0;

  const cacheHitCostNanoCny = hit * pricing.inputCacheHitNanoCnyPerToken;
  const cacheMissCostNanoCny = miss * pricing.inputCacheMissNanoCnyPerToken;
  const outputCostNanoCny = out * pricing.outputNanoCnyPerToken;

  return {
    cacheHitCostNanoCny,
    cacheMissCostNanoCny,
    outputCostNanoCny,
    totalCostNanoCny: cacheHitCostNanoCny + cacheMissCostNanoCny + outputCostNanoCny,
  };
}
