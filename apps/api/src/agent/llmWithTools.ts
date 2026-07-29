import type { LlmCallUsage, LlmProvider } from '@aiops/shared-types';
import { stripLoneSurrogates } from '../textSafety.js';
import { recordViaContext, type LlmUsageContext } from '../services/usage/usageTracker.js';
import type { RawProviderUsage } from '../services/usage/normalizeUsage.js';

// ============================================================
// 消息类型（支持 tool calling）
// ============================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 角色的 tool_calls */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** tool 角色的 tool_call_id */
  tool_call_id?: string;
  /** DeepSeek Reasoner 的思维链内容（必须在带 tool_calls 的 assistant 消息中回传） */
  reasoning_content?: string | null;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null;
  /** DeepSeek Reasoner 的思维链内容 */
  reasoningContent: string | null;
}

export interface BuildChatCompletionRequestBodyOptions {
  provider: LlmProvider;
  model: string;
  maxTokens?: number;
}

// ============================================================
// 带工具的 LLM 调用
// ============================================================

/**
 * 调用 OpenAI 兼容的 chat/completions 接口（支持 function calling）。
 * 对于不支持 function calling 的模型，降级为文本解析模式。
 */
export async function callChatCompletionWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: {
    provider: LlmProvider;
    model: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
    maxTokens?: number;
    /** 外部中止信号（客户端断连）——与内部超时先到先杀（P1-D 遗留④：agent 管线 abort 贯穿） */
    signal?: AbortSignal;
    /** 成本追踪上下文（阶段 3）。agent 一轮会打很多次，靠 stage + stageCallIndex 分项 */
    usage?: LlmUsageContext;
  },
): Promise<ChatCompletionResult> {
  const { provider, model, baseUrl, apiKey, timeoutMs = 60000, maxTokens = 4096, signal, usage } = opts;
  const isOllama = provider === 'ollama' || provider === 'local';
  const startedAt = Date.now();
  const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);

  /** agent 侧的 usage 上报出口。工具轮和最终答案都走这里，只是 stage 不同 */
  const report = (
    transportStatus: 'success' | 'error' | 'aborted',
    rawUsage: RawProviderUsage | null,
    extra?: { errorKind?: LlmCallUsage['errorKind']; outputChars?: number },
  ): void => {
    recordViaContext(usage, {
      provider, model, baseUrl,
      transportStatus, deliveryMode: 'non_stream', rawUsage,
      latencyMs: Date.now() - startedAt,
      errorKind: extra?.errorKind,
      ephemeral: { promptChars, outputChars: extra?.outputChars },
    });
  };

  const url = resolveChatCompletionUrl(baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = buildChatCompletionRequestBody(messages, tools, { provider, model, maxTokens });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onExternalAbort);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // 先记账再抛：这次调用真的发生过，失败也要留下痕迹（错误原文不入库，只留状态码类别）
      report('error', null, { errorKind: resp.status >= 500 ? 'http_5xx' : 'http_4xx' });
      throw new Error(`LLM API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = (await resp.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: 'function';
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      // Ollama 原生格式
      message?: { content?: string };
      usage?: RawProviderUsage;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    // Ollama 原生响应把 token 数放在顶层，OpenAI 兼容放在 usage 里
    const rawUsage: RawProviderUsage | null =
      json.usage ??
      (json.prompt_eval_count !== undefined || json.eval_count !== undefined
        ? { prompt_eval_count: json.prompt_eval_count, eval_count: json.eval_count }
        : null);

    // OpenAI 格式
    const choice = json.choices?.[0]?.message;
    if (choice) {
      const toolCalls = choice.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })) ?? null;

      const content = typeof choice.content === 'string' ? choice.content : null;
      report('success', rawUsage, { outputChars: content?.length });
      return {
        content,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
        reasoningContent: typeof choice.reasoning_content === 'string' ? choice.reasoning_content : null,
      };
    }

    // Ollama 原生格式
    const ollamaContent = json.message?.content;
    if (ollamaContent && isOllama && tools.length > 0) {
      // 尝试从文本中解析工具调用
      const parsed = parseToolCallsFromText(ollamaContent);
      if (parsed) {
        report('success', rawUsage, { outputChars: ollamaContent.length });
        return parsed;
      }
    }

    report('success', rawUsage, { outputChars: ollamaContent?.length });
    return {
      content: typeof ollamaContent === 'string' ? ollamaContent : null,
      toolCalls: null,
      reasoningContent: null,
    };
  } catch (err) {
    // 抛给上层前先记账：超时/断连/网络错误都是"真的发起过"的调用。
    // resp.ok 分支已自行记过账，这里靠 errorKind 区分，不会重复——那条抛出的 Error 不是 AbortError。
    if (!(err instanceof Error) || !err.message.startsWith('LLM API ')) {
      report(signal?.aborted ? 'aborted' : 'error', null, {
        errorKind: signal?.aborted ? 'aborted' : (err as { name?: string })?.name === 'AbortError' ? 'timeout' : 'network',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ============================================================
// 辅助函数
// ============================================================

export function buildChatCompletionRequestBody(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: BuildChatCompletionRequestBodyOptions,
): Record<string, unknown> {
  const { provider, model, maxTokens = 4096 } = opts;
  const isOllama = provider === 'ollama' || provider === 'local';

  const body: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: buildApiMessages(messages),
  };

  if (tools.length > 0 && !isOllama) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (tools.length > 0 && isOllama) {
    body.messages = injectToolsAsText(messages, tools);
  }

  return body;
}

function resolveChatCompletionUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/chat/completions`;
}

function buildApiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const msg: Record<string, unknown> = {
      role: m.role,
      content: sanitizeMessageText(m.content),
    };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.role === 'assistant' && m.reasoning_content !== undefined) {
      msg.reasoning_content = sanitizeMessageText(m.reasoning_content);
    }
    return msg;
  });
}

/**
 * 规范化发往 LLM 的文本：移除落单的 UTF-16 代理项，保证请求体一定是合法 JSON。
 * 触发场景：tools.ts 的 truncate() 按字符截断含 📁/📄 的工具结果时劈断代理对。
 * 详见 {@link stripLoneSurrogates}。
 */
export function sanitizeMessageText(text: string | null | undefined): string | null | undefined {
  if (typeof text !== 'string' || text.length === 0) return text;
  return stripLoneSurrogates(text);
}

/**
 * Ollama 降级：将工具定义注入 system 消息的文本中
 */
function injectToolsAsText(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Array<Record<string, unknown>> {
  const toolDesc = tools
    .map(
      (t) =>
        `- ${t.function.name}: ${t.function.description}\n  参数: ${JSON.stringify(t.function.parameters)}`,
    )
    .join('\n');

  const injection = `\n\n你拥有以下工具可以使用。当你需要调用工具时，请严格使用以下 XML 格式输出（可以一次调用多个工具）：
<tool_call>
{"name": "工具名", "arguments": {"参数名": "值"}}
</tool_call>

可用工具：
${toolDesc}

如果你不需要调用工具，直接用自然语言回答即可。`;

  // 只给首条 system（agent 主系统提示）注入工具目录——历史窗口里可能还有别的 system
  // 消息（P2-H 会话摘要、记忆块），给每条都追加会重复付几百 token 且把"XML 输出"指令
  // 混进背景摘要内容里（review 修复）
  let injected = false;
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: sanitizeMessageText(m.content) };
    if (!injected && m.role === 'system' && typeof m.content === 'string') {
      msg.content = sanitizeMessageText(m.content + injection);
      injected = true;
    }
    return msg;
  });
}

/**
 * 从文本中解析 <tool_call>...</tool_call> 格式的工具调用
 */
function parseToolCallsFromText(text: string): ChatCompletionResult | null {
  const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  let match: RegExpExecArray | null;
  let counter = 0;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
      calls.push({
        id: `text_call_${counter++}`,
        name: parsed.name,
        arguments: JSON.stringify(parsed.arguments ?? {}),
      });
    } catch {
      // 忽略解析失败的工具调用
    }
  }

  if (calls.length === 0) return null;

  // 提取非工具调用部分作为 content
  const contentParts = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();

  return {
    content: contentParts || null,
    toolCalls: calls,
    reasoningContent: null,
  };
}
