import type { GraphStore } from '@aiops/graph-core'
import type { AgentEvent, LlmProvider } from '@aiops/shared-types'
import { AGENT_MAX_TURNS, AGENT_SINGLE_LLM_TIMEOUT_MS, AGENT_TOTAL_TIMEOUT_MS } from '../context.js'
import { executeTool, getOpenAITools } from './tools.js'
import { callChatCompletionWithTools, type ChatMessage, type ToolDefinition } from './llmWithTools.js'
import { AGENT_SYSTEM_PROMPT } from './prompt.js'
import { shouldPlan, generatePlan, renderPlanForPrompt } from './planner.js'
import { getAgentCompressThresholds } from '../services/ask/contextBudget.js'
import { reflectOnAnswer } from '../services/ask/reflection.js'
import { indexToolObservations, collectAgentEvidence, type ToolObservation } from './evidenceCollector.js'

// ============================================================
// 配置
// ============================================================

const MAX_TURNS = AGENT_MAX_TURNS
const TOTAL_TIMEOUT_MS = AGENT_TOTAL_TIMEOUT_MS
const SINGLE_LLM_TIMEOUT_MS = AGENT_SINGLE_LLM_TIMEOUT_MS

/** 同一 (工具名+参数) 最多原样返回几次结果，超过即注入提示而非重复喂回 */
const REPEAT_CALL_LIMIT = 2
/** 连续多少轮「全部是重复调用」即判定卡死，强制收尾 */
const STALL_TURN_LIMIT = 2

// ============================================================
// Agent ReAct 循环
// ============================================================

export interface AgentLoopOptions {
  question: string
  /** 跨轮历史（自然语言问答，注入到 system 与当前 user 之间） */
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  graphStore: GraphStore | null
  repoPath: string
  onEvent: (event: AgentEvent) => void
  /**
   * 外部中止信号（客户端断连，P1-D 遗留④）：轮首检查 + 全部 LLM 调用透传。
   * 中止后循环静默退出（不发事件——连接已死，没有观众）。
   */
  signal?: AbortSignal
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
  const { question, graphStore, repoPath, onEvent, llm, signal } = opts

  if (signal?.aborted) return

  const tools: ToolDefinition[] = getOpenAITools()
  const messages: ChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...(opts.history ?? []).map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
    { role: 'user', content: question },
  ]

  const startTime = Date.now()

  // ====== 任务规划（P1-C）：长任务先列计划再执行，简单问题直通 ======
  // 规划失败一律静默降级为无计划（增强不是闸门）；计划以 system 消息注入，
  // 位置在压缩保护区（compressMessages 从第 3 条起折叠，system 不受影响）。
  if (shouldPlan(question)) {
    const planSteps = await generatePlan(question, {
      provider: llm.provider,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      timeoutMs: SINGLE_LLM_TIMEOUT_MS,
      signal,
    })
    if (planSteps) {
      messages.splice(1, 0, { role: 'system', content: renderPlanForPrompt(planSteps) })
      onEvent({ type: 'plan', data: { planSteps } })
    }
  }

  // 自校验（P0-A·T1）用的观察记录：模型通过工具实际看到过哪些行，
  // 收尾时还原成 Evidence[] 交给 reflectOnAnswer 的 L1 引用核对。
  const observations: ToolObservation[] = []

  // 请求级工具结果缓存：key = "工具名:参数JSON"
  const toolCache = new Map<string, string>()
  // 重复调用计数：key = "工具名:参数JSON" → 调用次数，用于检测死循环
  const toolCallCounts = new Map<string, number>()
  // 连续「整轮都是重复调用」的次数
  let stalledTurns = 0

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 客户端断连：静默停循环（连接已死，事件没有观众；trace 由路由层收尾）
    if (signal?.aborted) return

    // 超时检查
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      onEvent({ type: 'error', data: { error: `达到最大推理时间（${formatDuration(TOTAL_TIMEOUT_MS)}）` } })
      return
    }

    // 上下文压缩：渐进式压缩
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
        signal,
      })
    } catch (err) {
      // 断连引发的 AbortError 不是错误，静默退出即可
      if (signal?.aborted) return
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

      // 并行执行所有工具
      const toolResults = await Promise.all(
        result.toolCalls.map(async tc => {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.arguments)
          } catch {
            args = {}
          }

          const cacheKey = `${tc.name}:${tc.arguments}`
          const callCount = (toolCallCounts.get(cacheKey) ?? 0) + 1
          toolCallCounts.set(cacheKey, callCount)

          // 死循环防护：同一调用重复过多次时，不再喂回原结果，
          // 改注入纠偏提示，打断「相同参数 → 相同结果 → 相同思考」的闭环
          if (callCount > REPEAT_CALL_LIMIT) {
            return { tc, args, toolResult: buildRepeatHint(tc.name, args), isRepeat: true }
          }

          // 检查缓存
          let toolResult: string
          const cached = toolCache.get(cacheKey)
          if (cached !== undefined) {
            toolResult = cached
          } else {
            toolResult = await executeTool(tc.name, args, graphStore, repoPath)
            toolCache.set(cacheKey, toolResult)
          }

          return { tc, args, toolResult, isRepeat: false }
        }),
      )

      // 统一发送 SSE 事件并追加消息
      for (const { tc, args, toolResult, isRepeat } of toolResults) {
        // 观察记录：重复调用返回的是纠偏提示而非真实结果，不能进证据索引
        if (!isRepeat) observations.push({ toolName: tc.name, args, result: toolResult })

        onEvent({
          type: 'tool_call',
          data: { toolName: tc.name, toolArgs: args },
        })

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

      // 死循环检测：本轮工具调用是否「全部是重复调用」
      // 连续 STALL_TURN_LIMIT 轮无新进展 → 强制收尾，逼模型基于已有信息作答
      const allRepeat = toolResults.length > 0 && toolResults.every(r => r.isRepeat)
      stalledTurns = allRepeat ? stalledTurns + 1 : 0
      if (stalledTurns >= STALL_TURN_LIMIT) {
        const forced = await forceFinalAnswer(messages, question, llm, onEvent, undefined, signal)
        if (forced !== null) await finalizeAnswer({ answer: forced, question, repoPath, observations, messages, llm, onEvent, signal })
        return
      }

      continue // 继续下一轮 LLM 调用
    }

    // 无工具调用 → 最终回答
    if (result.content) {
      await finalizeAnswer({ answer: result.content, question, repoPath, observations, messages, llm, onEvent, signal })
      return
    }

    // 既没有工具调用也没有内容 → 异常
    onEvent({ type: 'error', data: { error: 'LLM 返回空响应' } })
    return
  }

  // 超过最大轮次：不再硬报错——按计划/已收集信息优雅收尾（P1-C）
  const forced = await forceFinalAnswer(
    messages, question, llm, onEvent,
    '【系统指令】已达到最大探索轮次。请立即停止调用任何工具，基于以上已收集的信息用中文给出最终回答：' +
    '若存在执行计划，逐条说明每一步的完成情况与结论；未完成的步骤明确标注"未完成"及原因。',
    signal,
  )
  if (forced !== null) await finalizeAnswer({ answer: forced, question, repoPath, observations, messages, llm, onEvent, signal })
}

/**
 * 收尾：自校验（P0-A·T1）后再发 answer_delta / done。
 *
 * 顺序有讲究——**反思必须在 answer_delta 之前**：先把答案推给前端再重答，
 * 就成了"答案被撤回"的割裂体验（ask 侧流式路径正因此只记录不重试，见 P1-D 遗留①）。
 * agent 侧当前是整段推送（非 token 级流式），所以这里可以放心地先自查再下发。
 *
 * 失败一律放行原答案：反思是增强不是闸门（与 ask 侧同款纪律）。最多重答 1 次防成本失控。
 */
async function finalizeAnswer(opts: {
  answer: string
  question: string
  repoPath: string
  observations: ToolObservation[]
  messages: ChatMessage[]
  llm: AgentLoopOptions['llm']
  onEvent: (event: AgentEvent) => void
  signal?: AbortSignal
}): Promise<void> {
  const { answer, question, repoPath, observations, messages, llm, onEvent, signal } = opts
  if (signal?.aborted) return

  // 证据 = 答案里的 file:line 引用 × 模型在工具结果里实际看到的那一行（见 evidenceCollector 头注）
  const evidence = collectAgentEvidence(answer, indexToolObservations(observations))
  const reflection = await reflectOnAnswer({ question, answer, evidence, repoPath })

  let finalText = answer
  if (!reflection.pass && reflection.feedback && !signal?.aborted) {
    // 前端可见的"自查中"信号（未接入的前端会忽略未知事件类型，不会炸）
    onEvent({ type: 'reflecting', data: { citationAccuracy: reflection.meta.citationAccuracy ?? undefined } })
    messages.push({ role: 'assistant', content: answer })
    messages.push({ role: 'user', content: reflection.feedback })
    try {
      // 空 tools：重答阶段不允许再发起工具调用，必须基于已有信息修正
      const retry = await callChatCompletionWithTools(messages, [], {
        provider: llm.provider,
        model: llm.model,
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        timeoutMs: SINGLE_LLM_TIMEOUT_MS,
        maxTokens: llm.maxTokens,
        signal,
      })
      if (retry.content?.trim()) finalText = retry.content.trim()
    } catch {
      if (signal?.aborted) return
      // 重答失败：放行原答案（不因自查挂掉而让用户拿不到回答）
    }
  }

  if (signal?.aborted) return
  onEvent({ type: 'answer_delta', data: { delta: finalText } })
  onEvent({
    type: 'done',
    data: {
      answer: finalText,
      followUp: generateFollowUp(question),
      // 观测（路由层据此记 reflection span）：null = L1 未跑（无引用/无 repoPath）
      citationAccuracy: reflection.meta.citationAccuracy ?? undefined,
      reflectionRetried: finalText !== answer,
    },
  })
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 构造重复调用的纠偏提示：当模型以相同参数反复调用同一工具时，
 * 用这段文本替代真实结果，明确告知「已读过」并引导改用更精确的手段或直接作答。
 */
function buildRepeatHint(toolName: string, args: Record<string, unknown>): string {
  const target =
    (args.filePath as string) || (args.pattern as string) || (args.name as string) || ''
  return (
    `【系统提示】你已多次以相同参数调用 ${toolName}${target ? `（${target}）` : ''}，该结果此前已返回，请勿重复读取相同内容。\n` +
    '若仍需更多上下文，请改用 search_in_file 按方法名/关键词精确定位，或换不同的文件/范围；' +
    '若已能回答，请立即基于已掌握的信息给出最终回答，不要再调用任何工具。'
  )
}

/**
 * 强制收尾：禁用工具再调一次 LLM，逼模型基于现有信息输出文字答案。
 * 用于死循环检测（默认指令）与最大轮次耗尽（P1-C：按计划汇报进度）两个场景。
 *
 * 只负责"拿到答案文本"，不发 answer_delta / done——收尾统一走 finalizeAnswer
 * （T1 起要先自校验再下发）。返回 null 表示中止或调用失败（失败时已自行发 error 事件）。
 */
async function forceFinalAnswer(
  messages: ChatMessage[],
  question: string,
  llm: AgentLoopOptions['llm'],
  onEvent: (event: AgentEvent) => void,
  instruction?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null
  messages.push({
    role: 'user',
    content:
      instruction ??
      ('【系统指令】检测到工具被重复调用且未取得新进展。请立即停止调用任何工具，' +
        '基于以上已收集的信息用中文给出最终回答；若证据不足，请明确说明缺少哪部分信息。'),
  })
  try {
    // 传入空 tools 数组 → 模型无法再发起工具调用，必须输出文字答案
    const finalResult = await callChatCompletionWithTools(messages, [], {
      provider: llm.provider,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      timeoutMs: SINGLE_LLM_TIMEOUT_MS,
      maxTokens: llm.maxTokens,
      signal,
    })
    return (
      finalResult.content?.trim() ||
      '抱歉，在有限的探索步骤内未能收集到足够信息给出完整回答。建议缩小问题范围或指明具体文件后重试。'
    )
  } catch (err) {
    if (signal?.aborted) return null
    onEvent({
      type: 'error',
      data: { error: `强制收尾失败: ${err instanceof Error ? err.message : String(err)}` },
    })
    return null
  }
}

/**
 * 渐进式压缩消息列表：
 * - 轻度阈值（默认 20K 字符）：折叠较早的 tool 结果（阈值 500 字）
 * - 重度阈值（默认 40K 字符）：折叠阈值降至 150 字 + 清除早期 reasoning_content
 * 阈值经 AGENT_COMPRESS_LIGHT_CHARS / AGENT_COMPRESS_HEAVY_CHARS 可调（P2-H 预算收敛）。
 *
 * 关键：折叠时保留首行（含文件路径/读取范围）并用「已读取」措辞，
 * 而非「已压缩/已截断」——避免诱导模型误判内容缺失而反复重读（死循环根因）。
 */
function compressMessages(messages: ChatMessage[]): void {
  const estimateChars = () =>
    messages.reduce((sum, m) => {
      let len = m.content?.length ?? 0
      if (m.reasoning_content) len += m.reasoning_content.length
      return sum + len
    }, 0)

  const totalChars = estimateChars()

  const thresholds = getAgentCompressThresholds()
  if (totalChars < thresholds.lightChars) return

  const isHeavy = totalChars >= thresholds.heavyChars
  const toolTruncateLimit = isHeavy ? 150 : 500

  // 从第 3 条消息开始（跳过 system + 第一条 user），保留最近 6 条不折叠
  for (let i = 2; i < messages.length - 6; i++) {
    const msg = messages[i]
    // 折叠较早的 tool 结果：保留首行（文件路径/范围/匹配概要），正文换成「已读取」面包屑
    if (msg.role === 'tool' && msg.content && msg.content.length > toolTruncateLimit) {
      const firstLine = msg.content.split('\n', 1)[0]
      msg.content =
        `${firstLine}\n（此处内容此前已读取，为节省上下文已省略；如需该文件的具体细节，请用 search_in_file 按关键词精确定位，切勿整段重读）`
    }
    // 重度压缩时清除早期 reasoning_content
    if (isHeavy && msg.role === 'assistant' && msg.reasoning_content) {
      msg.reasoning_content = null
    }
  }
}

function formatDuration(ms: number): string {
  const minutes = ms / 60_000
  if (minutes >= 1) return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`
  return `${Math.ceil(ms / 1000)} 秒`
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
