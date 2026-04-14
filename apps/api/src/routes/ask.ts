import type { FastifyInstance } from 'fastify'
import path from 'path'
import type { AskResponse } from '@aiops/shared-types'
import { classifyIntent, analyzeQuestion } from '@aiops/nlp'
import { graphStore, fileNodeMap } from '../context.js'
import { callChatCompletion, canUseLlm } from '../services/llmService.js'
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
  app.post('/api/ask', async (request, reply) => {
    if (!ensureGraph(reply)) return
    const { question } = request.body as { question: string }
    if (!question || !question.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' })
    }

    try {
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
          return buildApiListResponse(question, anchor, endpointHits)
        }
      }

      // ====== Step 2: 检索相关代码 ======
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

      const candidateNodes = findRelevantNodes(searchQuery, 60, {
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

      // ====== Step 4: LLM 分析回答 ======
      let answer: string
      let evidence: import('@aiops/shared-types').Evidence[]

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
${trimmedGraphContext}`

        const llmAnswer = await callChatCompletion([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ])

        if (llmAnswer) {
          answer = llmAnswer
          const extractedEvidence = extractEvidenceFromAnswer(llmAnswer, codeContext)
          const mergedMap = new Map<string, import('@aiops/shared-types').Evidence>()
          for (const item of traditionalEvidence) {
            mergedMap.set(`${item.file}:${item.line}:${item.label}`, item)
          }
          for (const item of extractedEvidence) {
            const key = `${item.file}:${item.line}:${item.label}`
            if (!mergedMap.has(key)) {
              mergedMap.set(key, item)
            }
          }
          evidence = [...mergedMap.values()].slice(0, 12)
        } else {
          evidence = traditionalEvidence
          answer = composeAnswer(question, finalIntent, answerNodes, trimmedGraph)
        }
      } else {
        evidence = traditionalEvidence
        answer = await composeAnswerWithLlm(question, finalIntent, answerNodes, trimmedGraph, evidence, plan, anchor)
      }

      const followUpNodes = answerNodes.slice(0, 3)
      const followUp = buildFollowUps(question, followUpNodes, plan)

      const response: AskResponse = {
        answer,
        evidence,
        graph: trimmedGraph,
        intent: finalIntent,
        confidence: Math.max(analysis.confidence, intentResult.confidence, 0.55),
        followUp,
      }

      return response
    } catch (err) {
      app.log.error(`问答失败: ${err instanceof Error ? err.message : String(err)}`)
      return reply.code(500).send({ error: 'ASK_FAILED', message: '问答处理失败，请稍后重试' })
    }
  })
}
