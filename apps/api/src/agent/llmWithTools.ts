import type { LlmProvider } from '@aiops/shared-types';

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
  },
): Promise<ChatCompletionResult> {
  const { provider, model, baseUrl, apiKey, timeoutMs = 60000, maxTokens = 4096 } = opts;

  const url = resolveChatCompletionUrl(baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const isOllama = provider === 'ollama' || provider === 'local';

  // 构建请求体
  const body: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      // DeepSeek Reasoner 要求 assistant 消息中回传 reasoning_content
      if (m.role === 'assistant' && m.reasoning_content !== undefined) {
        msg.reasoning_content = m.reasoning_content;
      }
      return msg;
    }),
  };

  // Ollama 可能不支持 tools 参数，检测是否使用文本降级
  if (tools.length > 0 && !isOllama) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  // 如果是 Ollama 且有工具，在 system 消息里注入工具说明
  if (tools.length > 0 && isOllama) {
    body.messages = injectToolsAsText(messages, tools);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
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
    };

    // OpenAI 格式
    const choice = json.choices?.[0]?.message;
    if (choice) {
      const toolCalls = choice.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })) ?? null;

      return {
        content: typeof choice.content === 'string' ? choice.content : null,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
        reasoningContent: typeof choice.reasoning_content === 'string' ? choice.reasoning_content : null,
      };
    }

    // Ollama 原生格式
    const ollamaContent = json.message?.content;
    if (ollamaContent && isOllama && tools.length > 0) {
      // 尝试从文本中解析工具调用
      const parsed = parseToolCallsFromText(ollamaContent);
      if (parsed) return parsed;
    }

    return {
      content: typeof ollamaContent === 'string' ? ollamaContent : null,
      toolCalls: null,
      reasoningContent: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 辅助函数
// ============================================================

function resolveChatCompletionUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/chat/completions`;
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

  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === 'system' && typeof m.content === 'string') {
      msg.content = m.content + injection;
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
