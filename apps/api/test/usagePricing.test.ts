/**
 * 成本追踪 · 阶段 1 单测：价格目录 / usage 归一化 / 金额格式化。
 *
 * 这三块是纯函数，所以是整套成本功能里唯一能做到"精确到分毫可断言"的部分——
 * 后面的采集、结算、UI 都建立在它们算得对的前提上，这里松一寸后面全是错数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePricing,
  computeCost,
  canonicalizeModel,
  isOfficialDeepSeekOrigin,
  resetPricingCatalog,
  PRICING_CATALOG_VERSION,
} from '../src/services/usage/pricingCatalog.ts';
import { normalizeProviderUsage } from '../src/services/usage/normalizeUsage.ts';
import { formatNanoCny, formatNanoCnyPrecise, formatTokens, formatCacheHitRate } from '../src/services/usage/format.ts';

const OFFICIAL = 'https://api.deepseek.com/v1';

beforeEach(() => {
  delete process.env.LLM_PRICING_CNY_JSON;
  resetPricingCatalog();
});
afterEach(() => {
  delete process.env.LLM_PRICING_CNY_JSON;
  resetPricingCatalog();
});

describe('PricingCatalog · 官方价格精确值', () => {
  it('deepseek-v4-flash 的三档单价（nano-CNY/token）', () => {
    const p = resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)!;
    expect(p.inputCacheHitNanoCnyPerToken).toBe(20); // ¥0.02/百万
    expect(p.inputCacheMissNanoCnyPerToken).toBe(1000); // ¥1/百万
    expect(p.outputNanoCnyPerToken).toBe(2000); // ¥2/百万
    expect(p.matchKind).toBe('exact_model');
    expect(p.supportsPromptCache).toBe(true);
    expect(p.catalogVersion).toBe(PRICING_CATALOG_VERSION);
  });

  it('deepseek-v4-pro 的三档单价', () => {
    const p = resolvePricing('deepseek', 'deepseek-v4-pro', OFFICIAL)!;
    expect(p.inputCacheHitNanoCnyPerToken).toBe(25);
    expect(p.inputCacheMissNanoCnyPerToken).toBe(3000);
    expect(p.outputNanoCnyPerToken).toBe(6000);
  });

  it('多分项求和：hit/miss/output 各自计价后相加', () => {
    const p = resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)!;
    const cost = computeCost({ cacheHitTokens: 1000, cacheMissTokens: 500, completionTokens: 300 }, p);
    expect(cost.cacheHitCostNanoCny).toBe(20_000); // 1000 × 20
    expect(cost.cacheMissCostNanoCny).toBe(500_000); // 500 × 1000
    expect(cost.outputCostNanoCny).toBe(600_000); // 300 × 2000
    expect(cost.totalCostNanoCny).toBe(1_120_000); // ¥0.00112
  });

  it('reasoning 不重复收费（它是 completion 的子集）', () => {
    const p = resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)!;
    const withReasoning = computeCost({ completionTokens: 300, reasoningTokens: 200 }, p);
    const without = computeCost({ completionTokens: 300 }, p);
    expect(withReasoning.totalCostNanoCny).toBe(without.totalCostNanoCny);
  });

  it('未知模型返回 null —— Token 照记、金额留空，不套用别的模型价', () => {
    expect(resolvePricing('openai', 'gpt-9-turbo', 'https://api.openai.com/v1')).toBeNull();
    expect(canonicalizeModel('openai', 'gpt-9-turbo')).toBe('gpt-9-turbo');
  });
});

describe('PricingCatalog · 官方别名与 origin 约束', () => {
  it('官方 origin 下 deepseek-chat / deepseek-reasoner 归一到 flash，并标 official_alias', () => {
    for (const alias of ['deepseek-chat', 'deepseek-reasoner']) {
      const p = resolvePricing('deepseek', alias, OFFICIAL)!;
      expect(p.canonicalModel).toBe('deepseek-v4-flash');
      expect(p.matchKind).toBe('official_alias');
      expect(p.inputCacheMissNanoCnyPerToken).toBe(1000);
    }
  });

  it.each([
    ['https://api.deepseek.com', true, '基准'],
    ['https://api.deepseek.com/', true, '尾斜杠'],
    ['https://api.deepseek.com/v1', true, '项目实际配置形态'],
    ['https://API.DeepSeek.com/v1', true, 'host 大小写不敏感'],
    ['https://api.deepseek.com/beta', true, '官方 beta 端点'],
    ['https://api.deepseek.com.evil.tld/v1', false, '后缀伪装必须挡住'],
    ['http://api.deepseek.com', false, '明文 scheme 视为代理改写'],
    ['https://llm-gateway.corp.local/v1', false, '内网代理'],
    ['', false, '空值'],
    ['not-a-url', false, '非法 URL'],
  ])('origin 归一化：%s → 官方=%s（%s）', (url, expected) => {
    expect(isOfficialDeepSeekOrigin(url)).toBe(expected);
  });

  it('代理 origin 下同名模型不套官方别名价（同一个名字背后可能是别的模型）', () => {
    expect(resolvePricing('deepseek', 'deepseek-chat', 'https://llm-gateway.corp.local/v1')).toBeNull();
    // provider 不是 deepseek 也不认别名
    expect(resolvePricing('custom', 'deepseek-chat', OFFICIAL)).toBeNull();
  });
});

describe('PricingCatalog · 自定义价格覆盖', () => {
  it('LLM_PRICING_CNY_JSON 可补充内置没有的模型，标 custom_override', () => {
    process.env.LLM_PRICING_CNY_JSON = JSON.stringify({
      'qwen-local': { inputCacheHit: 0, inputCacheMiss: 0.5, output: 1.5, supportsPromptCache: false },
    });
    resetPricingCatalog();
    const p = resolvePricing('ollama', 'qwen-local', 'http://localhost:11434/v1')!;
    expect(p.matchKind).toBe('custom_override');
    expect(p.inputCacheMissNanoCnyPerToken).toBe(500);
    expect(p.outputNanoCnyPerToken).toBe(1500);
    expect(p.supportsPromptCache).toBe(false);
  });

  it('覆盖优先于内置（同名模型以用户配置为准）', () => {
    process.env.LLM_PRICING_CNY_JSON = JSON.stringify({
      'deepseek-v4-flash': { inputCacheHit: 1, inputCacheMiss: 2, output: 3 },
    });
    resetPricingCatalog();
    expect(resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)!.outputNanoCnyPerToken).toBe(3000);
  });

  it('非法配置只忽略该条并告警，不影响其他模型，更不能抛错阻断 LLM 调用', () => {
    const warned: string[] = [];
    process.env.LLM_PRICING_CNY_JSON = JSON.stringify({
      broken: { inputCacheMiss: 'free' },
      ok: { inputCacheHit: 0, inputCacheMiss: 1, output: 2 },
    });
    resetPricingCatalog();
    expect(resolvePricing('custom', 'broken', '', { warn: (m) => warned.push(m) })).toBeNull();
    expect(resolvePricing('custom', 'ok', '')).not.toBeNull();
    expect(warned.join('\n')).toContain('broken');
  });

  it('整段 JSON 非法时全部忽略，内置价仍可用', () => {
    process.env.LLM_PRICING_CNY_JSON = '{ 这不是 json';
    resetPricingCatalog();
    expect(resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)).not.toBeNull();
  });
});

describe('金额格式化 · 正成本永不显示为 ¥0', () => {
  it('1 个缓存命中 token（20 nano）显示 <¥0.000001，不是 ¥0', () => {
    const p = resolvePricing('deepseek', 'deepseek-v4-flash', OFFICIAL)!;
    const cost = computeCost({ cacheHitTokens: 1 }, p);
    expect(cost.totalCostNanoCny).toBe(20);
    expect(formatNanoCny(cost.totalCostNanoCny)).toBe('<¥0.000001');
    // 明细区要能看到真实数值，供人工复算
    expect(formatNanoCnyPrecise(cost.totalCostNanoCny)).toBe('¥0.00000002');
  });

  it('只有真的 0 才显示 ¥0', () => {
    expect(formatNanoCny(0)).toBe('¥0');
    expect(formatNanoCny(999)).toBe('<¥0.000001'); // 阈值边界内侧
    expect(formatNanoCny(1000)).toBe('¥0.000001'); // 边界上即可正常显示
  });

  it('常规金额去尾零', () => {
    expect(formatNanoCny(11_300_000)).toBe('¥0.0113');
    expect(formatNanoCny(1_000_000_000)).toBe('¥1');
  });

  it('Token 与命中率格式', () => {
    expect(formatTokens(18_400)).toBe('18.4k');
    expect(formatTokens(999)).toBe('999');
    expect(formatCacheHitRate(0.636)).toBe('63.6%');
  });
});

describe('usage 归一化', () => {
  it('DeepSeek 完整 usage：hit/miss/reasoning 全解析，标 provider', () => {
    const r = normalizeProviderUsage({
      prompt_tokens: 1500,
      prompt_cache_hit_tokens: 1000,
      prompt_cache_miss_tokens: 500,
      completion_tokens: 300,
      total_tokens: 1800,
      completion_tokens_details: { reasoning_tokens: 120 },
    });
    expect(r.usageSource).toBe('provider');
    expect(r.tokens).toEqual({
      promptTokens: 1500,
      cacheHitTokens: 1000,
      cacheMissTokens: 500,
      completionTokens: 300,
      reasoningTokens: 120,
      totalTokens: 1800,
    });
    expect(r.validationWarnings).toEqual([]);
  });

  it('缺缓存拆分 → 全按未命中（成本上界）并标 estimated', () => {
    const r = normalizeProviderUsage({ prompt_tokens: 800, completion_tokens: 100, total_tokens: 900 });
    expect(r.usageSource).toBe('estimated');
    expect(r.tokens.cacheHitTokens).toBe(0);
    expect(r.tokens.cacheMissTokens).toBe(800);
  });

  it('usage 整体缺失 → missing，Token 留空（不能用 0 冒充）', () => {
    for (const raw of [null, undefined, {}]) {
      const r = normalizeProviderUsage(raw);
      expect(r.usageSource).toBe('missing');
      expect(r.tokens).toEqual({});
    }
  });

  it('Ollama 字段名（prompt_eval_count / eval_count）', () => {
    const r = normalizeProviderUsage({ prompt_eval_count: 200, eval_count: 50 });
    expect(r.tokens.promptTokens).toBe(200);
    expect(r.tokens.completionTokens).toBe(50);
    expect(r.tokens.totalTokens).toBe(250);
    expect(r.usageSource).toBe('estimated'); // 无缓存拆分
  });

  it('供应商数据自相矛盾时保留原值 + 记 warning，绝不静默改写', () => {
    const r = normalizeProviderUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 200, // 900+200 ≠ 1000
      completion_tokens: 100,
      total_tokens: 9999, // ≠ 1000+100
      reasoning_tokens: 500, // > completion
    });
    expect(r.validationWarnings.sort()).toEqual(
      ['prompt_cache_mismatch', 'reasoning_exceeds_completion', 'total_token_mismatch'].sort(),
    );
    expect(r.tokens.cacheHitTokens).toBe(900);
    expect(r.tokens.totalTokens).toBe(9999);
  });

  it('只给了一半缓存拆分时按 prompt 补另一半', () => {
    const r = normalizeProviderUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600, completion_tokens: 10 });
    expect(r.tokens.cacheMissTokens).toBe(400);
    expect(r.usageSource).toBe('provider');
    expect(r.validationWarnings).toEqual([]);
  });
});
