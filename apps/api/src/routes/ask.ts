import type { FastifyInstance } from 'fastify'
import path from 'path'
import type { AskResponse } from '@aiops/shared-types'
import { classifyIntent, analyzeQuestion } from '@aiops/nlp'
import { graphStore, fileNodeMap, resolveActiveProjectId, currentRepoName, currentRepoPath } from '../context.js'
import { reflectOnAnswer } from '../services/ask/reflection.js'
import { retrieveDocEvidence, renderDocEvidenceForPrompt } from '../services/ask/docRecall.js'
import { callChatCompletion, callChatCompletionStream, canUseLlm, getLastLlmCallMeta } from '../services/llmService.js'
import { startAskTrace, setTraceServiceLogger, type AskTrace } from '../services/traceService.js'
import { createConversation, getConversation, appendMessage, buildLlmHistory } from '../db/conversationStore.js'
import { retrieveMemoryBlock, generateMemoriesFromTurn } from '../services/memoryService.js'
import {
  ensureGraph,
  isApiListQuestion,
  isComponentFeatureQuestion,
  isFlowQuestion,
  isPaginationQuestion,
  isUiConditionQuestion,
  findBestPageAnchorByText,
  collectPageEndpointHits,
  buildApiListResponse,
  findRelevantNodes,
  findRelevantNodesWithSemantic,
  mergeNodesByOrder,
  prioritizeNodesByFileScope,
  collectComponentScopeFiles,
  collectComponentScopeTerms,
  pickHintedComponentFiles,
  tokenizeForRecall,
  recallFacts,
  collectNodesFromFacts,
  generateQuestionPlan,
  buildFollowUps,
  composeAnswer,
  composeAnswerWithLlm,
  assembleCodeContext,
  buildEvidenceHints,
  buildGraphContext,
  extractEvidenceFromAnswer,
  estimateTokens,
  extractSearchTerms,
  extractQuestionCoreTerms,
  parseLine,
  buildEvidence,
  buildGenericEvidence,
  buildUiConditionEvidence,
  buildPaginationEvidence,
  buildFlowChainEvidence,
  buildGraphPathEvidence,
  buildActionBlockEvidence,
  buildComponentEvidence,
  enrichEvidenceWithButtonConditions,
  scoreEvidenceItem,
  evidenceCoversNeed,
  selectFallbackEvidenceByNeed,
  buildPlanEvidence,
  applyAnchorScope,
  selectStartNode,
} from '../services/askService.js'

export function registerAsk(app: FastifyInstance): void {
  setTraceServiceLogger(app.log)
  app.post('/api/ask', async (request, reply) => {
    if (!ensureGraph(reply)) return
    const { question, conversationId, stream } = request.body as { question: string; conversationId?: string; stream?: boolean }
    if (!question || !question.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' })
    }

    // ====== 流式模式（P1-D）：body.stream=true 时走 SSE，否则整包 JSON（默认，零变化）======
    // 事件协议与 agent 路由一致：answer_delta 逐 token + done 终帧（含完整 AskResponse）。
    // 中断：客户端断开连接 → abortCtl 中止进行中的 LLM 流（trace 记 cancelled）。
    const sse = stream === true
    const abortCtl = new AbortController()
    const sendSse = (type: string, data: unknown): void => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify({ type, data })}\n\n`)
    }
    if (sse) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      request.raw.on('close', () => abortCtl.abort())
    }

    // L4 观测：未配置 Langfuse 时 startAskTrace 返回 no-op facade，主链路零开销
    let trace: AskTrace | null = null
    // 流式模式下是否已逐 token 下发过答案（finalizeResponse 据此决定要不要补整帧 delta）
    let streamedTokens = false

    try {
      // ====== Step 0: 解析/创建会话，落库用户消息，取多轮历史 ======
      const projectId = resolveActiveProjectId()
      const memoryBlock = retrieveMemoryBlock(projectId, question)
      let convId: string | null = null
      let history: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
      try {
        const conv = (conversationId ? getConversation(conversationId) : null) ?? createConversation(projectId, question.slice(0, 40))
        convId = conv.id
        history = buildLlmHistory(convId, 1500)
        appendMessage(convId, { role: 'user', content: question, mode: 'rag' })
      } catch (err) {
        app.log.error(`对话持久化(用户消息)失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      trace = startAskTrace({ question, projectId, conversationId: convId, repoName: currentRepoName })
      // extractMemory：仅在"复杂问答（走了 LLM 阅读代码那条路）"时才后台沉淀记忆；
      // 快速路径(API 清单)与规则兜底答案信号低、易产生噪音，默认不抽取。
      // 返回 undefined = SSE 模式已用 done 帧收尾（handler 不再返回 JSON）
      const finalizeResponse = (resp: AskResponse, extractMemory = false): AskResponse | undefined => {
        if (convId) {
          try {
            appendMessage(convId, {
              role: 'assistant',
              content: resp.answer,
              mode: 'rag',
              meta: { followUp: resp.followUp, intent: resp.intent, confidence: resp.confidence, evidenceCount: resp.evidence.length },
            })
          } catch (err) {
            app.log.error(`对话持久化(回答)失败: ${err instanceof Error ? err.message : String(err)}`)
          }
          // 后台沉淀记忆（fire-and-forget，不阻断响应）
          if (extractMemory) void generateMemoriesFromTurn(projectId, convId, question, resp.answer)
          resp.conversationId = convId
        }
        // 所有成功路径（快速路径/规则兜底/LLM）都走这个漏斗——观测收尾放这里全覆盖
        trace?.end({ answer: resp.answer, evidence: resp.evidence, intent: resp.intent, confidence: resp.confidence, answeredByLlm: extractMemory })
        // 流式模式：答案若未经逐 token 下发（快速路径/规则路径/流式降级），补一帧整体 delta；
        // done 终帧带完整 AskResponse（evidence/graph/docEvidence），前端以此收尾渲染。
        if (sse) {
          if (!streamedTokens) sendSse('answer_delta', { delta: resp.answer })
          sendSse('done', resp)
          reply.raw.end()
          return undefined
        }
        return resp
      }

      // ====== Step 1: 理解问题 — LLM 驱动意图+实体提取 ======
      const [analysis, plan] = await Promise.all([
        analyzeQuestion(
          question,
          callChatCompletion as (messages: Array<{ role: string; content: string }>) => Promise<string | null>,
        ),
        generateQuestionPlan(question),
      ])
      plan.keywords = Array.from(new Set([...plan.keywords, ...analysis.searchKeywords])).slice(0, 24)
      if (analysis.entities.pageName && !plan.scope) {
        plan.scope = analysis.entities.pageName
      }

      const scopedAnchor = plan.scope && plan.scope.trim().length >= 4 ? findBestPageAnchorByText(plan.scope) : null
      const anchor =
        scopedAnchor ||
        (analysis.entities.pageName ? findBestPageAnchorByText(analysis.entities.pageName) : null) ||
        findBestPageAnchorByText(question)

      // API 列表快速路径
      if (isApiListQuestion(question) && anchor) {
        const endpointHits = collectPageEndpointHits(anchor)
        if (endpointHits.length > 0) {
          return finalizeResponse(buildApiListResponse(question, anchor, endpointHits))
        }
      }

      // ====== Step 2: 检索相关代码 ======
      const tRecall = Date.now()
      const componentQuestion = plan.concern === 'component_relation' || isComponentFeatureQuestion(question)
      const componentFiles = anchor?.componentFile
        ? collectComponentScopeFiles(anchor.componentFile, componentQuestion ? 3 : 2, 180)
        : []
      const hintedComponentFiles = pickHintedComponentFiles(question, componentFiles)
      const componentTerms = collectComponentScopeTerms(componentFiles)

      const searchQuery = [
        question,
        analysis.entities.pageName ?? '',
        analysis.entities.functionName ?? '',
        analysis.entities.componentName ?? '',
        analysis.entities.buttonName ?? '',
        anchor?.title ?? '',
        anchor?.componentFile ?? '',
        ...componentTerms.slice(0, 12),
      ]
        .filter(Boolean)
        .join(' ')

      // 主召回走词法+语义 RRF 融合（语义索引未就绪/embedding 不可用时自动退化为纯词法）。
      // 其余 findRelevantNodes 调用点是英文标识符 scope 收窄，词法足够，不值得多付一跳 embed 延迟。
      const candidateNodes = await findRelevantNodesWithSemantic(searchQuery, 60, {
        ...plan,
        keywords: [...plan.keywords, ...componentTerms.slice(0, 12)],
      })

      let rankedNodes = candidateNodes
      if (anchor) {
        const anchorTerms = [
          ...tokenizeForRecall(anchor.title),
          ...tokenizeForRecall(anchor.componentFile),
          ...tokenizeForRecall(anchor.routeName ?? ''),
          ...componentTerms.slice(0, 10),
        ]
        const anchorNodes = findRelevantNodes(`${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`, 60, {
          ...plan,
          keywords: [...plan.keywords, ...anchorTerms],
          scope: anchor.title,
        })
        rankedNodes = mergeNodesByOrder(anchorNodes, rankedNodes)
      }

      if (componentFiles.length > 0) {
        const componentScopedNodes = rankedNodes.filter(node => componentFiles.includes(node.filePath))
        const componentNodes = findRelevantNodes(
          `${question} ${componentTerms.join(' ')}`,
          componentQuestion ? 90 : 55,
          {
            ...plan,
            scope: plan.scope ?? anchor?.title,
            keywords: [...plan.keywords, ...componentTerms],
          },
        )
        rankedNodes = mergeNodesByOrder(componentScopedNodes, componentNodes, rankedNodes)
      }
      if (hintedComponentFiles.length > 0) {
        rankedNodes = prioritizeNodesByFileScope(rankedNodes, hintedComponentFiles)
      }

      // fact 召回
      const factScopeFiles = Array.from(
        new Set([...(anchor?.componentFile ? [anchor.componentFile] : []), ...hintedComponentFiles, ...componentFiles]),
      )
      const factHits = recallFacts(
        question,
        { ...plan, keywords: [...plan.keywords, ...componentTerms.slice(0, 12)] },
        factScopeFiles,
        60,
      )
      if (factHits.length > 0) {
        const factNodes = collectNodesFromFacts(factHits, 55)
        rankedNodes = mergeNodesByOrder(factNodes, rankedNodes)
      }

      rankedNodes = applyAnchorScope(rankedNodes, anchor, plan, [...hintedComponentFiles, ...componentFiles])
      if (anchor && plan.concern !== 'general') {
        const scopeDir = path.dirname(anchor.componentFile)
        const scopedFiles = Array.from(
          new Set([anchor.componentFile, ...componentFiles.filter(file => file.startsWith(scopeDir))]),
        )
        const scopedNodes = scopedFiles.flatMap(file => fileNodeMap.get(file) ?? [])
        if (scopedNodes.length > 0) {
          rankedNodes = mergeNodesByOrder(scopedNodes, rankedNodes)
        }
      }
      if (componentQuestion && componentFiles.length > 0) {
        rankedNodes = prioritizeNodesByFileScope(rankedNodes, [...hintedComponentFiles, ...componentFiles])
      }
      rankedNodes = rankedNodes.slice(0, 80)
      const analysisNodes = rankedNodes.filter(node => node.type !== 'import' && node.type !== 'file')
      const answerNodes = analysisNodes.length > 0 ? analysisNodes : rankedNodes
      trace?.span('recall', tRecall, { candidates: candidateNodes.length, ranked: rankedNodes.length })

      // 图谱追踪
      const intentResult = classifyIntent(question)
      const finalIntent = plan.intentHint ?? (analysis.intent !== 'GENERAL' ? analysis.intent : intentResult.intent)
      const startNode = selectStartNode(
        question,
        answerNodes,
        plan,
        [...hintedComponentFiles, ...componentFiles],
        anchor,
      )
      const graph = startNode ? graphStore!.traceBidirectional(startNode.id, 3, 2) : { nodes: [], edges: [] }
      const trimmedGraph = {
        nodes: graph.nodes.slice(0, 180),
        edges: graph.edges.slice(0, 260),
      }

      // ====== Step 3: 组装代码上下文 ======
      const CODE_BUDGET = 6000
      const EVIDENCE_BUDGET = 1500
      const GRAPH_BUDGET = 800

      const codeContext = assembleCodeContext(answerNodes, trimmedGraph, CODE_BUDGET)
      const traditionalEvidence = buildPlanEvidence(question, rankedNodes, plan, anchor, [
        ...hintedComponentFiles,
        ...componentFiles,
      ])

      // 文档证据（P0-B）：独立通道，只在答案层融合，不进代码召回。
      // 未配 DOCS_PATH / 索引未建 / embedding 不可用时恒为 []，下方所有逻辑零变化。
      const docEvidence = await retrieveDocEvidence(question, 4)

      // ====== Step 4: LLM 分析回答 ======
      const tAnswer = Date.now()
      let answer: string
      let evidence: import('@aiops/shared-types').Evidence[]
      // 仅当回答确由 LLM 阅读代码生成（复杂问答）时才沉淀记忆，见 finalizeResponse
      let answeredByLlm = false

      const complexConcerns = new Set([
        'click_flow',
        'ui_condition',
        'data_source',
        'state_flow',
        'general',
        'error_trace',
      ])
      const needsCodeReading =
        complexConcerns.has(plan.concern) ||
        finalIntent === 'CLICK_FLOW' ||
        finalIntent === 'UI_CONDITION' ||
        finalIntent === 'DATA_SOURCE' ||
        finalIntent === 'STATE_FLOW' ||
        finalIntent === 'ERROR_TRACE' ||
        finalIntent === 'GENERAL'

      if (canUseLlm() && codeContext.trim().length > 50 && needsCodeReading) {
        const evidenceHints = buildEvidenceHints(traditionalEvidence, codeContext, EVIDENCE_BUDGET)
        const graphContext = buildGraphContext(trimmedGraph)
        const trimmedGraphContext =
          estimateTokens(graphContext) > GRAPH_BUDGET
            ? graphContext
                .split('\n')
                .reduce((acc: string[], line: string) => {
                  const candidate = [...acc, line].join('\n')
                  return estimateTokens(candidate) <= GRAPH_BUDGET ? [...acc, line] : acc
                }, [])
                .join('\n')
            : graphContext

        const systemPrompt = `你是代码库分析助手。你会收到：
1. 用户的代码问题
2. 从代码库中检索到的相关代码片段（带文件名和行号）
3. 系统通过规则引擎预定位的证据线索（可能包含关键条件、触发点、接口调用等）
4. 代码之间的调用关系图

请综合"相关代码"和"证据线索"两部分信息回答问题。要求：
- 只基于给定信息回答，不要编造
- 行号纪律：只引用「相关代码」或「证据线索」中明确标注的行号；材料未展示的部分（如文件头部 import、模板结构），可以描述其行为，但不要给出具体行号——宁可少一条行号，不可编一条
- 证据线索是通过确定性规则抽取的关键行，优先参考；代码片段提供完整上下文
- 如果证据线索和代码片段有冲突，以代码片段中的实际代码为准
- 输出格式：
  结论：一句话白话结论
  实现说明：条件→触发→状态变化→接口调用的逻辑链（缺失段明确标注"证据不足"）
  关键代码：列出 3-8 条 文件:行号 + 该行做了什么
  证据不足：如有未确认的部分，明确说明
- 语言要面向业务同学，避免术语堆砌
- 如果问题是"页面用了哪些接口"，按"接口清单"逐条列出 METHOD + endpoint`

        const entitiesInfo: string[] = []
        if (analysis.entities.pageName) entitiesInfo.push(`页面：${analysis.entities.pageName}`)
        if (analysis.entities.buttonName) entitiesInfo.push(`按钮：${analysis.entities.buttonName}`)
        if (analysis.entities.functionName) entitiesInfo.push(`函数：${analysis.entities.functionName}`)
        if (analysis.entities.componentName) entitiesInfo.push(`组件：${analysis.entities.componentName}`)

        const userPrompt = `问题：${question}
${entitiesInfo.length > 0 ? entitiesInfo.join('\n') : ''}
问题关注点：${plan.concern}
页面范围：${plan.scope ?? anchor?.title ?? '未指定'}

相关代码：
${codeContext}

系统已定位的证据线索：
${evidenceHints}

调用关系：
${trimmedGraphContext}${renderDocEvidenceForPrompt(docEvidence)}`

        const llmMessages = [
          { role: 'system' as const, content: systemPrompt },
          ...(memoryBlock ? [{ role: 'system' as const, content: memoryBlock }] : []),
          ...history,
          { role: 'user' as const, content: userPrompt },
        ]
        // 流式优先（P1-D）：SSE 模式逐 token 下发；流式不可用（内网模式/网络失败）自动降级整包。
        let llmAnswer: string | null = null
        if (sse) {
          const streamed = await callChatCompletionStream(
            llmMessages,
            (delta) => {
              streamedTokens = true
              sendSse('answer_delta', { delta })
            },
            abortCtl.signal,
          )
          if (streamed?.aborted) {
            // 用户中断：不落库、不继续管线，记观测后直接收尾
            trace?.error(new Error('client_cancelled'))
            reply.raw.end()
            return undefined
          }
          llmAnswer = streamed?.text || null
        }
        if (!llmAnswer) {
          llmAnswer = await callChatCompletion(llmMessages)
        }

        // 从 LLM 文本组装 answer + evidence（首答与反思重答共用同一套逻辑）
        const composeFromLlm = (text: string): { answer: string; evidence: import('@aiops/shared-types').Evidence[] } => {
          const extractedEvidence = extractEvidenceFromAnswer(text, codeContext)
          // 合并顺序（有讲究）：页面锚点 → 答案自引的行 → 规则预定位的行，容量 12。
          // 答案实际引用的 file:line 必须优先保住——它们是用户核对答案的第一线索；
          // 旧顺序 traditional 在前会把自引行挤出清单，造成"答案与展示证据脱节"
          //（L3 judge 曾因此把真实引用误判为不忠实——行是真的，只是清单里没有）。
          const anchorItem = traditionalEvidence.find((item) => item.label === '页面锚点')
          const mergedMap = new Map<string, import('@aiops/shared-types').Evidence>()
          for (const item of [...(anchorItem ? [anchorItem] : []), ...extractedEvidence, ...traditionalEvidence]) {
            const key = `${item.file}:${item.line}:${item.label}`
            if (!mergedMap.has(key)) {
              mergedMap.set(key, item)
            }
          }
          return { answer: text, evidence: [...mergedMap.values()].slice(0, 12) }
        }

        if (llmAnswer) {
          answeredByLlm = true
          let composed = composeFromLlm(llmAnswer)

          // ====== 自校验（P0-A）：答案先自查，不合格带反馈重答一次 ======
          // 反思失败/异常一律放行原答案（增强不是闸门）；最多重试 1 次防成本失控。
          const tReflect = Date.now()
          const reflection = await reflectOnAnswer({
            question,
            answer: composed.answer,
            evidence: composed.evidence,
            repoPath: currentRepoPath,
            codeContext,
          })
          // 流式模式跳过重试：token 已推给用户，重答会造成"答案被撤回"的割裂体验。
          // 反思结果仍进 trace（可观测流式答案的质量水位）。
          // TODO(P1-D 后续): 前端支持"答案修正"交互后（如折叠旧答案），放开流式重试。
          if (!sse && !reflection.pass && reflection.feedback) {
            const retryAnswer = await callChatCompletion([
              ...llmMessages,
              { role: 'assistant' as const, content: composed.answer },
              { role: 'user' as const, content: reflection.feedback },
            ])
            if (retryAnswer) {
              composed = composeFromLlm(retryAnswer)
              // TODO(评测跟进): 重答后可再跑一次 reflectOnAnswer 做"仍不合格"统计，
              // 但绝不二次重试；等 eval -- answers 观察一轮真实数据后再决定是否需要。
            }
          }
          trace?.span('reflection', tReflect, { ...reflection.meta, retried: !reflection.pass })

          answer = composed.answer
          evidence = composed.evidence
        } else {
          evidence = traditionalEvidence
          answer = composeAnswer(question, finalIntent, answerNodes, trimmedGraph)
        }
      } else {
        evidence = traditionalEvidence
        // TODO(P0-B 后续): 简单路径（composeAnswerWithLlm）暂不注入文档证据与反思——
        // 该路径 prompt 在 answer.ts 内部组装，注入需改其签名；等复杂路径跑出真实收益再动它。
        answer = await composeAnswerWithLlm(question, finalIntent, answerNodes, trimmedGraph, evidence, plan, anchor)
      }
      {
        // 紧跟主 LLM 调用之后同步读取，无 await 插入 → 元数据对应的就是这次调用
        const llmMeta = getLastLlmCallMeta()
        trace?.generation('answer', tAnswer, {
          model: llmMeta?.model,
          usage: llmMeta ? { promptTokens: llmMeta.promptTokens, completionTokens: llmMeta.completionTokens, totalTokens: llmMeta.totalTokens } : undefined,
          promptChars: codeContext.length,
          outputChars: answer.length,
        })
      }

      const followUpNodes = answerNodes.slice(0, 3)
      const followUp = buildFollowUps(question, followUpNodes, plan)

      const response: AskResponse = {
        answer,
        evidence,
        // 文档证据独立下发（与代码 evidence 分开渲染）；空数组时不带此字段，前端行为同现状
        ...(docEvidence.length > 0 ? { docEvidence } : {}),
        // 评测用途：judge 口径对齐需要答案的真实信息源（见 shared-types 注释）；仅 LLM 路径有值
        ...(answeredByLlm ? { codeContextPreview: codeContext.slice(0, 6500) } : {}),
        graph: trimmedGraph,
        intent: finalIntent,
        confidence: Math.max(analysis.confidence, intentResult.confidence, 0.55),
        followUp,
      }

      return finalizeResponse(response, answeredByLlm)
    } catch (err) {
      trace?.error(err)
      app.log.error(`问答失败: ${err instanceof Error ? err.message : String(err)}`)
      // SSE 已开始时响应头不可再改，用错误帧收尾
      if (sse) {
        sendSse('error', { error: '问答处理失败，请稍后重试' })
        reply.raw.end()
        return undefined
      }
      return reply.code(500).send({ error: 'ASK_FAILED', message: '问答处理失败，请稍后重试' })
    }
  })
}
