import type { FastifyBaseLogger } from 'fastify';
import type {
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
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
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

export async function callApiCompatibleChatCompletion(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  provider: LlmProvider,
  model: string,
  baseUrl: string
): Promise<string | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (LLM_API_KEY) {
    headers.authorization = `Bearer ${LLM_API_KEY}`;
  }

  const timeout = Number.isFinite(LLM_TIMEOUT_MS) && LLM_TIMEOUT_MS > 0 ? LLM_TIMEOUT_MS : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(resolveChatCompletionUrl(baseUrl || getDefaultApiBaseUrl(provider)), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: LLM_MAX_TOKENS,
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`LLM API 调用失败: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const json = await resp.json() as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const rawContent = json.choices?.[0]?.message?.content;
    if (typeof rawContent === 'string') return rawContent.trim();
    if (Array.isArray(rawContent)) {
      const text = rawContent.map((item) => item?.text ?? '').join('').trim();
      return text || null;
    }
    return null;
  } catch (err) {
    _log?.warn(`LLM API 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function callOllamaChatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string | null> {
  const baseUrl = INTRANET_OLLAMA_BASE_URL;
  const model = getCurrentLlmModel();
  if (!baseUrl || !model) return null;

  const timeout = Number.isFinite(INTRANET_OLLAMA_TIMEOUT_MS) && INTRANET_OLLAMA_TIMEOUT_MS > 0 ? INTRANET_OLLAMA_TIMEOUT_MS : 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: LLM_MAX_TOKENS },
        messages,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      _log?.warn(`内网 Ollama 调用失败: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const json = await resp.json() as { message?: { content?: string } };
    return json.message?.content?.trim() || null;
  } catch (err) {
    _log?.warn(`内网 Ollama 调用异常: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function callChatCompletion(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string | null> {
  if (!canUseLlm()) return null;
  if (llmRuntimeState.mode === 'intranet') {
    const ollamaResult = await callOllamaChatCompletion(messages);
    if (ollamaResult) return ollamaResult;
    if (canUseApiLlm()) {
      _log?.warn('内网 Ollama 调用失败，自动降级为 API 模式');
      llmRuntimeState.mode = 'api';
      return callApiCompatibleChatCompletion(
        messages,
        llmRuntimeState.apiProvider,
        llmRuntimeState.apiModel || DEFAULT_API_MODEL,
        llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL
      );
    }
    return null;
  }
  return callApiCompatibleChatCompletion(
    messages,
    llmRuntimeState.apiProvider,
    getCurrentLlmModel(),
    llmRuntimeState.apiBaseUrl || DEFAULT_API_BASE_URL
  );
}
