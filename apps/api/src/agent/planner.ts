/**
 * 任务规划（P1-C）—— agent 循环的前置规划：长任务先列 3~7 步计划再执行。
 *
 * 为什么需要：纯 ReAct 对"梳理整个 XX 链路并出报告"这类长任务缺全局视野，
 * 轮数常浪费在重复搜索上；一份计划让模型知道"接下来还差什么"，也让用户
 * 在前端看到 checklist（plan SSE 事件）。
 *
 * 设计约束（改动前请读）：
 *   - 规划失败/解析失败/LLM 超时 → 返回 null，循环按原样跑（规划是增强不是闸门）。
 *   - 简单问题（定位类短问题）跳过规划——省一次 LLM 调用与 ~2s 延迟。
 *   - 步骤只有 goal 文本，不做逐步状态机——执行进度靠模型在循环里自然推进；
 *     TODO(P1-C 后续): 若评测显示模型跑偏，再考虑每轮让模型自报"当前在第几步"
 *     并回发 plan 更新事件（成本：每轮多一段输出，先不加）。
 */
import type { ChatMessage } from './llmWithTools.js'
import type { LlmUsageContext } from '../services/usage/usageTracker.js';
import { callChatCompletionWithTools } from './llmWithTools.js'

export interface PlanOptions {
  provider: import('@aiops/shared-types').LlmProvider
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  /** 外部中止信号（客户端断连）——规划调用同样不该在断连后白跑 */
  signal?: AbortSignal
  /** 成本追踪：规划器是一次独立 LLM 调用，单独分 stage（agent.planner） */
  usage?: LlmUsageContext
}

/**
 * 是否值得先规划：长任务信号词，或问题本身较长（复合诉求大概率是长任务）。
 * 判定宁可保守——误跳过只是少个 checklist，误规划则白付一次 LLM 调用。
 */
export function shouldPlan(question: string): boolean {
  // PLANNER_DISABLE=1：整体关规划器（P1-C 验收的 on/off 对照实验用；生产默认不设）
  if (process.env.PLANNER_DISABLE === '1') return false
  if (question.length >= 60) return true
  return /(梳理|链路|流程|全流程|报告|排查|从头|完整|整体|所有|逐个|对比|重构|方案|架构|如何实现|怎么实现)/.test(question)
}

/**
 * 生成 3~7 步计划。任何失败返回 null（调用方按无计划继续）。
 */
export async function generatePlan(question: string, llm: PlanOptions): Promise<string[] | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是代码分析任务的规划器。用户会给出一个代码库分析问题，你只负责拆解步骤，不负责回答。',
        '输出 3~7 步的执行计划，每步是一个可用代码检索工具完成的具体动作（如"定位 XX 页面组件文件"、"追踪 XX 方法的调用链"）。',
        '只输出一个 JSON 对象，不要任何其他文字：{"steps":["步骤1","步骤2",...]}',
      ].join('\n'),
    },
    { role: 'user', content: question },
  ]
  try {
    // 空 tools → 模型只能输出文本
    const result = await callChatCompletionWithTools(messages, [], {
      provider: llm.provider,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      timeoutMs: llm.timeoutMs,
      signal: llm.signal,
      usage: llm.usage,
    })
    const text = result.content ?? ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const parsed = JSON.parse(text.slice(start, end + 1)) as { steps?: unknown }
    if (!Array.isArray(parsed.steps)) return null
    const steps = parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 7)
    return steps.length >= 2 ? steps : null
  } catch {
    return null
  }
}

/** 计划注入循环的 system 片段：让模型带着全局视野执行，并约束收尾行为。 */
export function renderPlanForPrompt(steps: string[]): string {
  return [
    '本次任务的执行计划（按序推进，可根据发现合理调整，但不要偏离目标）：',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '执行要求：每一步用最少的工具调用取证；全部步骤完成或信息已足够时，立即停止调用工具并给出最终回答；若某步无法完成，说明原因并继续后续步骤。',
  ].join('\n')
}
