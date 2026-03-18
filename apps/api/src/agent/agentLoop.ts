import type { GraphStore } from '@aiops/graph-core'
import type { AgentEvent, LlmProvider } from '@aiops/shared-types'
import { executeTool, getOpenAITools } from './tools.js'
import { callChatCompletionWithTools, type ChatMessage, type ToolDefinition } from './llmWithTools.js'
import { AGENT_SYSTEM_PROMPT } from './prompt.js'

// ============================================================
// 配置
// ============================================================

const MAX_TURNS = 50
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000 // 5 分钟
const SINGLE_LLM_TIMEOUT_MS = 60_000

// ============================================================
// Agent ReAct 循环
// ============================================================

export interface AgentLoopOptions {
  question: string
  graphStore: GraphStore | null
  repoPath: string
  onEvent: (event: AgentEvent) => void
  /** LLM 配置 */
  llm: {
    provider: LlmProvider
    model: string
    baseUrl: string
    apiKey: string
    maxTokens?: number
  }
}

export async function agentLoop(opts: AgentLoopOptions): Promise<void> {
  const { question, graphStore, repoPath, onEvent, llm } = opts

  const tools: ToolDefinition[] = getOpenAITools()
  const messages: ChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: question },
  ]

  const startTime = Date.now()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 超时检查
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      onEvent({ type: 'error', data: { error: '达到最大推理时间（5 分钟）' } })
      return
    }

    // 上下文压缩：当消息过多时压缩早期工具结果
    compressMessages(messages)

    let result
    try {
      result = await callChatCompletionWithTools(messages, tools, {
        provider: llm.provider,
        model: llm.model,
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        timeoutMs: SINGLE_LLM_TIMEOUT_MS,
        maxTokens: llm.maxTokens,
      })
    } catch (err) {
      onEvent({
        type: 'error',
        data: { error: `LLM 调用失败: ${err instanceof Error ? err.message : String(err)}` },
      })
      return
    }

    // 处理工具调用
    if (result.toolCalls && result.toolCalls.length > 0) {
      // 如果有思考内容，先发送（优先使用 reasoningContent，即 DeepSeek Reasoner 的思维链）
      const thinking = result.reasoningContent || result.content
      if (thinking) {
        onEvent({ type: 'thinking', data: { thought: thinking } })
      }

      // 记录 assistant 消息（含 tool_calls 及可能的 reasoning_content）
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
      // DeepSeek Reasoner 要求回传 reasoning_content
      if (result.reasoningContent !== null) {
        assistantMsg.reasoning_content = result.reasoningContent
      }
      messages.push(assistantMsg)

      // 依次执行工具
      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.arguments)
        } catch {
          args = {}
        }

        onEvent({
          type: 'tool_call',
          data: { toolName: tc.name, toolArgs: args },
        })

        const toolResult = executeTool(tc.name, args, graphStore, repoPath)

        onEvent({
          type: 'tool_result',
          data: { toolResult: toolResult.slice(0, 500) }, // SSE 摘要
        })

        messages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
        })
      }

      continue // 继续下一轮 LLM 调用
    }

    // 无工具调用 → 最终回答
    if (result.content) {
      onEvent({ type: 'answer_delta', data: { delta: result.content } })
      onEvent({
        type: 'done',
        data: {
          answer: result.content,
          followUp: generateFollowUp(question),
        },
      })
      return
    }

    // 既没有工具调用也没有内容 → 异常
    onEvent({ type: 'error', data: { error: 'LLM 返回空响应' } })
    return
  }

  // 超过最大轮次
  onEvent({ type: 'error', data: { error: '达到最大推理轮次（30 轮）' } })
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 压缩消息列表：当工具结果消息过多时，截断早期的工具输出
 */
function compressMessages(messages: ChatMessage[]): void {
  // 粗略估算 token 数（1 字符 ≈ 0.5 token 中文，1 token 英文）
  const estimateTokens = () => messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)

  const TOKEN_LIMIT = 60_000 // 约 80% 的常见模型上下文窗口

  if (estimateTokens() < TOKEN_LIMIT) return

  // 从第 3 条消息开始（跳过 system + 第一条 user）压缩 tool 结果
  for (let i = 2; i < messages.length - 4; i++) {
    if (messages[i].role === 'tool' && messages[i].content && messages[i].content!.length > 200) {
      messages[i].content = messages[i].content!.slice(0, 200) + '\n... (已压缩)'
    }
    if (estimateTokens() < TOKEN_LIMIT) break
  }
}

/**
 * 根据问题生成追问建议
 */
function generateFollowUp(question: string): string[] {
  const suggestions: string[] = []

  if (/点击|按钮|事件/.test(question)) {
    suggestions.push('这个按钮还触发了哪些副作用？')
  }
  if (/接口|api|请求/.test(question)) {
    suggestions.push('这个接口的错误处理逻辑是怎样的？')
  }
  if (/页面|组件/.test(question)) {
    suggestions.push('这个页面的数据流向是怎样的？')
  }

  if (suggestions.length === 0) {
    suggestions.push('能展开说说相关的调用链路吗？')
    suggestions.push('这段逻辑有哪些边界情况需要注意？')
  }

  return suggestions.slice(0, 3)
}
