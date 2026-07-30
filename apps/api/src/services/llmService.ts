import type { FastifyBaseLogger } from 'fastify';
import type {
  LlmCallUsage,
  LlmOption,
  LlmProvider,
  LlmRuntimeConfig,
} from '@aiops/shared-types';
import {
  LLM_API_KEY,
  LLM_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  INTRANET_OLLAMA_TIMEOUT_MS,
  INTRANET_OLLAMA_BASE_URL,
  INTRANET_OLLAMA_MODELS,
  DEFAULT_API_PROVIDER,
  DEFAULT_API_MODEL,
  DEFAULT_API_BASE_URL,
  DEFAULT_INTRANET_MODEL,
  llmRuntimeState,
  getDefaultApiBaseUrl,
} from '../context.js';
import { stripLoneSurrogates } from '../textSafety.js';
import { recordViaContext, type LlmUsageContext } from './usage/usageTracker.js';
import type { RawProviderUsage } from './usage/normalizeUsage.js';

let _log: FastifyBaseLogger | undefined;

export function setLlmServiceLogger(log: FastifyBaseLogger): void {
  _log = log;
}

export function resolveChatCompletionUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  if (base.endsWith('/v1/')) return `${base}chat/completions`;
  return `${base}/chat/completions`;
}

export function buildApiModelOptions(provider: LlmProvider, currentModel: string): LlmOption[] {
  const defaults: Record<LlmProvider, string[]> = {
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'],
    bailian: ['qwen-plus', 'qwen-max'],
    local: ['qwen2.5:7b-instruct'],
    ollama: ['qwen2.5:7b-instruct'],
    custom: [],
  };
  const values = Array.from(new Set([currentModel, ...defaults[provider]].filter(Boolean)));
  return values.map((value) => ({ value, label: value }));
}

export async function fetchOllamaModelOptions(): Promise<LlmOption[]> {
  if (!INTRANET_OLLAMA_BASE_URL) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const resp = await fetch(`${INTRANET_OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`获取 Ollama 模型列表失败: ${resp.status} ${resp.statusText}`);
      return [];
    }

    const json = await resp.json() as { models?: Array<{ name?: string; model?: string }> };
    const values = (json.models ?? [])
      .map((item) => item.name?.trim() || item.model?.trim() || '')
      .filter(Boolean);

    return Array.from(new Set(values)).map((value) => ({ value, label: value }));
  } catch (err) {
    _log?.warn(`获取 Ollama 模型列表异常: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function canUseApiLlm(): boolean {
  const provider = llmRuntimeState.apiProvider;
  if (provider === 'local' || provider === 'ollama') return true;
  return Boolean(LLM_API_KEY);
}

export function getCurrentLlmProvider(): LlmProvider {
  return llmRuntimeState.mode === 'intranet' ? 'ollama' : llmRuntimeState.apiProvider;
}

export function getCurrentLlmModel(): string {
  return llmRuntimeState.mode === 'intranet'
    ? (llmRuntimeState.intranetModel || DEFAULT_INTRANET_MODEL)
    : (llmRuntimeState.apiModel || DEFAULT_API_MODEL);
}

export function getCurrentLlmBaseUrl(): string {
  return llmRuntimeState.mode === 'intranet'
    ? INTRANET_OLLAMA_BASE_URL
    : (llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL);
}

export function canUseLlm(): boolean {
  if (llmRuntimeState.mode === 'intranet') {
    return Boolean(INTRANET_OLLAMA_BASE_URL && getCurrentLlmModel());
  }
  return canUseApiLlm();
}

/**
 * callChatCompletionStream 会不会真的发起请求（评审 P4）。
 * false = 它在发请求前就返回 null（LLM 未配置，或纯内网无 API 兜底——ollama 流式协议未接）。
 * 调用方据此区分"没尝试"与"尝试失败"：没尝试过流式时，后面的非流式是主调用，
 * 不能记成 *_fallback，否则"流式失败率"从配置层面就被污染（设计文档 §11.1）。
 */
export function canAttemptStreamLlm(): boolean {
  if (!canUseLlm()) return false;
  return !(llmRuntimeState.mode === 'intranet' && !canUseApiLlm());
}

export function buildLlmRuntimeConfig(): LlmRuntimeConfig {
  const mode = llmRuntimeState.mode;
  const availableModes: LlmOption[] = [
    { value: 'api', label: `API / ${llmRuntimeState.apiProvider}` },
  ];
  if (INTRANET_OLLAMA_BASE_URL) {
    availableModes.push({ value: 'intranet', label: '内网 Ollama' });
  }

  const availableModels = mode === 'intranet'
    ? Array.from(new Set([llmRuntimeState.intranetModel, ...INTRANET_OLLAMA_MODELS].filter(Boolean)))
      .map((value) => ({ value, label: value }))
    : buildApiModelOptions(llmRuntimeState.apiProvider, llmRuntimeState.apiModel);

  return {
    mode,
    provider: getCurrentLlmProvider(),
    model: getCurrentLlmModel(),
    baseUrl: getCurrentLlmBaseUrl(),
    availableModes,
    availableModels,
    apiProvider: llmRuntimeState.apiProvider,
    apiModel: llmRuntimeState.apiModel,
    apiBaseUrl: llmRuntimeState.apiBaseUrl,
    intranetModel: llmRuntimeState.intranetModel,
    intranetBaseUrl: INTRANET_OLLAMA_BASE_URL,
    intranetEnabled: Boolean(INTRANET_OLLAMA_BASE_URL),
  };
}

export async function hydrateLlmRuntimeConfig(config: LlmRuntimeConfig): Promise<LlmRuntimeConfig> {
  // API 模式：直接返回，不混入 Ollama 模型
  if (config.mode !== 'intranet') return config;

  const remoteModels = await fetchOllamaModelOptions();
  if (remoteModels.length === 0) {
    if (canUseApiLlm()) {
      _log?.warn('内网模型配置获取失败，自动降级为 API 模式');
      llmRuntimeState.mode = 'api';
      return buildLlmRuntimeConfig();
    }
    return config;
  }

  // intranet 模式：用远程实际可用的模型列表替换
  return {
    ...config,
    availableModels: remoteModels,
  };
}

export function updateLlmRuntimeConfig(input: { mode?: string; model?: string }): LlmRuntimeConfig {
  const nextMode = input.mode === 'intranet' && INTRANET_OLLAMA_BASE_URL ? 'intranet' : 'api';
  llmRuntimeState.mode = nextMode;

  const nextModel = input.model != null ? String(input.model).trim() : '';
  if (nextMode === 'intranet') {
    llmRuntimeState.intranetModel = nextModel || DEFAULT_INTRANET_MODEL;
  } else {
    llmRuntimeState.apiModel = nextModel || DEFAULT_API_MODEL;
  }

  return buildLlmRuntimeConfig();
}

// lastCallMeta 单例已移除（成本追踪 · 阶段 3）：进程级可变状态，并发请求会串账，
// 且只覆盖 ask 主回答那一次调用。现在每次真实供应商调用都经 UsageTracker 记账，
// 并由 observer 同步上报 Langfuse（services/usage/langfuseObserver.ts）——
// 请求级、不串账、覆盖 agent 多轮 / 后台任务 / patch。

/**
 * 把一次真实供应商调用上报给 UsageTracker（成本追踪 · 阶段 3）。
 * 记在**最低层**：这样 intranet→api 的降级发生后，记的是真正花钱的那个 model/provider，
 * 而不是调用方以为在用的那个。
 */
function reportUsage(
  ctx: LlmUsageContext | undefined,
  args: {
    provider: LlmProvider;
    model: string;
    baseUrl?: string;
    startedAt: number;
    transportStatus: 'success' | 'error' | 'aborted';
    deliveryMode: 'stream' | 'non_stream';
    rawUsage?: RawProviderUsage | null;
    errorKind?: LlmCallUsage['errorKind'];
    promptChars?: number;
    outputChars?: number;
  },
): void {
  if (!ctx) return;
  recordViaContext(ctx, {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    transportStatus: args.transportStatus,
    deliveryMode: args.deliveryMode,
    rawUsage: args.rawUsage ?? null,
    latencyMs: Date.now() - args.startedAt,
    errorKind: args.errorKind,
    ephemeral: { promptChars: args.promptChars, outputChars: args.outputChars },
  });
}

/** HTTP 状态码 → 受控错误类别（usage 表只存枚举，不存响应原文） */
function httpErrorKind(status: number): LlmCallUsage['errorKind'] {
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'unknown';
}

/** 异常 → 受控错误类别。外部 signal 已 abort 记 aborted，否则超时/网络 */
function exceptionErrorKind(err: unknown, externalAborted: boolean): LlmCallUsage['errorKind'] {
  if (externalAborted) return 'aborted';
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  if (err instanceof TypeError) return 'network';
  return 'unknown';
}

function charsOf(messages: Array<{ content: string }>): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

export async function callApiCompatibleChatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  provider: LlmProvider,
  model: string,
  baseUrl: string,
  signal?: AbortSignal,
  usage?: LlmUsageContext,
): Promise<string | null> {
  const startedAt = Date.now();
  const effectiveBaseUrl = baseUrl || getDefaultApiBaseUrl(provider);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (LLM_API_KEY) {
    headers.authorization = `Bearer ${LLM_API_KEY}`;
  }

  const timeout = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  // 外部中止（客户端断连）与内部超时二选一先到先杀——非流式路径此前不接 abort，
  // 消费端断开后服务端会白跑完全部 LLM 调用（review 修复）
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onExternalAbort);

  try {
    const resp = await fetch(resolveChatCompletionUrl(effectiveBaseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        // 清洗落单代理项，避免严格 JSON 解析器（DeepSeek 等）因半截 emoji 报 400
        messages: messages.map((m) => ({ ...m, content: stripLoneSurrogates(m.content) })),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`LLM API 调用失败: ${resp.status} ${resp.statusText}`);
      reportUsage(usage, {
        provider, model, baseUrl: effectiveBaseUrl, startedAt,
        transportStatus: 'error', deliveryMode: 'non_stream',
        errorKind: httpErrorKind(resp.status), promptChars: charsOf(messages),
      });
      return null;
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: RawProviderUsage;
    };
    const rawContent = json.choices?.[0]?.message?.content;
    const text = typeof rawContent === 'string'
      ? rawContent.trim()
      : Array.isArray(rawContent)
        ? rawContent.map((item) => item?.text ?? '').join('').trim()
        : '';
    reportUsage(usage, {
      provider, model, baseUrl: effectiveBaseUrl, startedAt,
      transportStatus: 'success', deliveryMode: 'non_stream', rawUsage: json.usage,
      promptChars: charsOf(messages), outputChars: text.length,
    });
    return text || null;
  } catch (err) {
    _log?.warn(`LLM API 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    reportUsage(usage, {
      provider, model, baseUrl: effectiveBaseUrl, startedAt,
      transportStatus: signal?.aborted ? 'aborted' : 'error', deliveryMode: 'non_stream',
      errorKind: exceptionErrorKind(err, Boolean(signal?.aborted)), promptChars: charsOf(messages),
    });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function callOllamaChatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
  usage?: LlmUsageContext,
): Promise<string | null> {
  const baseUrl = INTRANET_OLLAMA_BASE_URL;
  const model = getCurrentLlmModel();
  if (!baseUrl || !model) return null;
  const startedAt = Date.now();

  const timeout = Number.isFinite(INTRANET_OLLAMA_TIMEOUT_MS) && INTRANET_OLLAMA_TIMEOUT_MS > 0 ? INTRANET_OLLAMA_TIMEOUT_MS : 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onExternalAbort);

  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: LLM_MAX_TOKENS },
        // 清洗落单代理项，避免严格 JSON 解析器因半截 emoji 报 400
        messages: messages.map((m) => ({ ...m, content: stripLoneSurrogates(m.content) })),
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`内网 Ollama 调用失败: ${resp.status} ${resp.statusText}`);
      reportUsage(usage, {
        provider: 'ollama', model, baseUrl, startedAt,
        transportStatus: 'error', deliveryMode: 'non_stream',
        errorKind: httpErrorKind(resp.status), promptChars: charsOf(messages),
      });
      return null;
    }

    const json = await resp.json() as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = json.message?.content?.trim() || '';
    reportUsage(usage, {
      provider: 'ollama', model, baseUrl, startedAt,
      transportStatus: 'success', deliveryMode: 'non_stream',
      rawUsage: { prompt_eval_count: json.prompt_eval_count, eval_count: json.eval_count },
      promptChars: charsOf(messages), outputChars: text.length,
    });
    return text || null;
  } catch (err) {
    _log?.warn(`内网 Ollama 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    reportUsage(usage, {
      provider: 'ollama', model, baseUrl, startedAt,
      transportStatus: signal?.aborted ? 'aborted' : 'error', deliveryMode: 'non_stream',
      errorKind: exceptionErrorKind(err, Boolean(signal?.aborted)), promptChars: charsOf(messages),
    });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 流式 Chat Completion（P1-D）。OpenAI 兼容 `stream:true`，逐 token 回调 onDelta。
 *
 * 行为约定（调用方请读）：
 *  - 返回 { text: 完整文本, aborted }；网络/解析失败返回 null（调用方自行降级到非流式）。
 *  - usage 通过 `stream_options.include_usage` 从最后一个 chunk 取，交给 UsageTracker
 *   （保住 L4 的 token 成本上报，语义与非流式一致）。
 *  - signal 中止（用户点停止/断开连接）不算错误：返回已累积的部分文本 + aborted=true。
 *  - TODO(P1-D 后续): 内网 ollama 模式暂不支持流式（/api/chat 的 NDJSON 协议不同），
 *    当前 intranet 模式直接返回 null，调用方会退回非流式路径。
 */
export async function callChatCompletionStream(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  usage?: LlmUsageContext,
): Promise<{ text: string; aborted: boolean } | null> {
  const startedAt = Date.now();
  // 末帧 usage 是否到手——没到手说明 token 已真实消耗但拿不到数（errorKind=stream_incomplete）
  let streamUsage: RawProviderUsage | null = null;
  // 「没尝试」出口（P4）：与下面所有"尝试后失败"的 null 不同，这里未发生任何请求、
  // 不产生 usage event；调用方用 canAttemptStreamLlm() 预判，别把后续非流式记成 fallback。
  // （intranet 模式 ollama 流式协议未接——见头注 TODO；配了 API 兜底则直接用 API 流式，
  //   与非流式路径的降级终点保持一致：intranet 失败 → api。）
  if (!canAttemptStreamLlm()) return null;

  const model = llmRuntimeState.mode === 'intranet'
    ? (llmRuntimeState.apiModel || DEFAULT_API_MODEL)
    : getCurrentLlmModel();
  const baseUrl = llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (LLM_API_KEY) headers.authorization = `Bearer ${LLM_API_KEY}`;

  const timeout = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 60000;
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeout);
  // 外部中止（用户停止）与内部超时二选一即中止
  const combined = signal ? AbortSignal.any([signal, timeoutCtl.signal]) : timeoutCtl.signal;

  let text = '';
  try {
    const resp = await fetch(resolveChatCompletionUrl(baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
        messages: messages.map((m) => ({ ...m, content: stripLoneSurrogates(m.content) })),
      }),
      signal: combined,
    });
    if (!resp.ok || !resp.body) {
      _log?.warn(`LLM 流式调用失败: ${resp.status} ${resp.statusText}`);
      // HTTP 层失败也要入账：非流式路径同款纪律（调用发生了就不能从账本上消失），
      // 否则「流式常态 + 上游持续 5xx」会表现为账本一片安静。
      reportUsage(usage, {
        provider: llmRuntimeState.apiProvider, model, baseUrl, startedAt,
        transportStatus: 'error', deliveryMode: 'stream',
        errorKind: httpErrorKind(resp.status), promptChars: charsOf(messages),
      });
      return null;
    }

    // SSE 解析：按空行分帧，每帧 "data: {json}" 或 "data: [DONE]"
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onDelta(delta);
          }
          // usage 只出现在最后一个 chunk（choices 为空数组）
          if (chunk.usage) {
            streamUsage = chunk.usage as RawProviderUsage;
          }
        } catch {
          // 单帧解析失败不致命，跳过
        }
      }
    }
    reportUsage(usage, {
      provider: llmRuntimeState.apiProvider, model, baseUrl, startedAt,
      // 流式跑完但末帧 usage 没到：token 真花了、数拿不到，标 missing + stream_incomplete
      transportStatus: streamUsage ? 'success' : 'error',
      deliveryMode: 'stream', rawUsage: streamUsage,
      errorKind: streamUsage ? undefined : 'stream_incomplete',
      promptChars: charsOf(messages), outputChars: text.length,
    });
    return { text, aborted: false };
  } catch (err) {
    // 用户中止：返回已累积的部分文本，不算错误
    if (signal?.aborted) {
      reportUsage(usage, {
        provider: llmRuntimeState.apiProvider, model, baseUrl, startedAt,
        transportStatus: 'aborted', deliveryMode: 'stream', rawUsage: streamUsage,
        errorKind: 'aborted', promptChars: charsOf(messages), outputChars: text.length,
      });
      return { text, aborted: true };
    }
    _log?.warn(`LLM 流式调用异常: ${err instanceof Error ? err.message : String(err)}`);
    reportUsage(usage, {
      provider: llmRuntimeState.apiProvider, model, baseUrl, startedAt,
      transportStatus: 'error', deliveryMode: 'stream', rawUsage: streamUsage,
      errorKind: streamUsage ? exceptionErrorKind(err, false) : 'stream_incomplete',
      promptChars: charsOf(messages), outputChars: text.length,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param usage 成本追踪上下文（可选）。注意 intranet→api 降级时**两次调用各自上报**：
 * 内网那次真的发生过（失败也可能已消耗 token），不能只记最后成功的那次。
 */
export async function callChatCompletion(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal,
  usage?: LlmUsageContext,
): Promise<string | null> {
  if (!canUseLlm()) return null;
  if (signal?.aborted) return null;
  if (llmRuntimeState.mode === 'intranet') {
    const ollamaResult = await callOllamaChatCompletion(messages, signal, usage);
    if (ollamaResult) return ollamaResult;
    if (signal?.aborted) return null;
    if (canUseApiLlm()) {
      _log?.warn('内网 Ollama 调用失败，自动降级为 API 模式');
      llmRuntimeState.mode = 'api';
      return callApiCompatibleChatCompletion(
        messages,
        llmRuntimeState.apiProvider,
        llmRuntimeState.apiModel || DEFAULT_API_MODEL,
        llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL,
        signal,
        usage,
      );
    }
    return null;
  }
  return callApiCompatibleChatCompletion(
    messages,
    llmRuntimeState.apiProvider,
    getCurrentLlmModel(),
    llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL,
    signal,
    usage,
  );
}
