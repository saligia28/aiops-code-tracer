import type { FastifyInstance } from 'fastify';
import type { AgentEvent, Evidence } from '@aiops/shared-types';
import { graphStore, currentRepoPath, currentRepoName, resolveActiveProjectId, LLM_API_KEY, LLM_MAX_TOKENS } from '../context.js';
import { startAskTrace } from '../services/traceService.js';
import { agentLoop } from '../agent/index.js';
import { getCurrentLlmProvider, getCurrentLlmModel, getCurrentLlmBaseUrl } from '../services/llmService.js';
import { createConversation, getConversationForProject, appendMessage, updateMessageMeta } from '../db/conversationStore.js';
import { setAssistantMessageId } from '../db/usageStore.js';
import { buildHistoryWindow } from '../services/ask/historyCompactor.js';
import { retrieveMemoryBlock, generateMemoriesFromTurn } from '../services/memoryService.js';
import { getContextBudgets } from '../services/ask/contextBudget.js';
import { createUsageTracker } from '../services/usage/usageTracker.js';
import { createLangfuseObserver } from '../services/usage/langfuseObserver.js';

/** 自校验（P0-A·T1）的 trace 元数据：由 reflecting / done 两个事件拼出。 */
interface ReflectionSpanMeta {
  citationAccuracy?: number;
  retried: boolean;
  /** reflecting 事件的时刻；未触发重答时为 undefined（span 退化为零耗时打点） */
  startedAt?: number;
}

export function registerAgent(app: FastifyInstance): void {
  app.post('/api/agent/ask', async (request, reply) => {
    const { question, conversationId, source } = request.body as {
      question?: string;
      conversationId?: string;
      /** 分组提示（自声明，非信任边界）：eval runner 显式传 'eval'，未知值回退 web */
      source?: string;
    };
    const usageSource: 'web' | 'mcp' | 'eval' = source === 'mcp' ? 'mcp' : source === 'eval' ? 'eval' : 'web';
    if (!question?.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
    }

    if (!graphStore) {
      return reply.code(503).send({ error: 'GRAPH_NOT_LOADED', message: '图谱未加载，请先运行索引构建' });
    }

    const q = question.trim();

    // 解析/创建会话，落库用户消息，取多轮历史（失败不阻断问答）
    const projectId = resolveActiveProjectId();
    const memoryBlock = await retrieveMemoryBlock(projectId, q);
    let convId: string | null = null;
    let historyConvId: string | null = null;
    let history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    try {
      // 归属校验（review 修复）：跨项目/失效的 conversationId 视作无效 → 新建会话
      const conv = (conversationId ? getConversationForProject(conversationId, projectId) : null) ?? createConversation(projectId, q.slice(0, 40));
      convId = conv.id;
      // P2-H：超预算历史用 LLM 摘要顶上（后台生成，当轮零延迟），短会话行为与纯截断一致
      historyConvId = convId;
      appendMessage(convId, { role: 'user', content: q, mode: 'agent' });
    } catch (err) {
      app.log.error(`对话持久化(用户消息)失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // SSE 响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // 中断贯穿（P1-D 遗留④）：客户端断开 → abort 循环与进行中的 LLM 调用。
    // 与 ask.ts 同款——监听响应侧 close 且未正常 end（request.raw 的 close 在请求体读完即触发，不可用）
    const abortCtl = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abortCtl.abort();
    });

    // 首事件回带会话 id，供前端落活动会话
    if (convId) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'conversation', data: { conversationId: convId } })}\n\n`);
    }

    // L4 观测：agent 管线同样上报（未配置 Langfuse 时为 no-op）
    const trace = startAskTrace({ name: 'agent', question: q, projectId, conversationId: convId, repoName: currentRepoName });
    // 成本追踪：一次 agent 请求 = 一个 turn（planner + N 轮 loop + 反思 + 后台任务全挂它）
    const usageTracker = createUsageTracker({
      projectId,
      conversationId: convId,
      pipeline: 'agent',
      source: usageSource,
      log: app.log,
      // agent 一轮几十次调用，逐次上报 Langfuse（旧的 lastCallMeta 单例根本覆盖不到这里）
      observer: createLangfuseObserver(trace),
    });
    // 历史窗口在 tracker 之后取：压缩是本轮触发的后台调用，成本归本轮
    if (historyConvId) {
      history = buildHistoryWindow(
        historyConvId,
        getContextBudgets().history,
        (err) => app.log.error(`历史摘要压缩失败: ${err instanceof Error ? err.message : String(err)}`),
        { register: () => usageTracker.registerBackground('background.history_compact') },
      );
    }
    const tLoop = Date.now();

    // 累积 agent 轨迹与最终答案，用于落库
    const steps: Array<Record<string, unknown>> = [];
    let finalAnswer = '';
    let finalFollowUp: string[] = [];
    // T19：agent 的结构化证据（此前 trace.end 一直硬写 evidence: []，观测里看不到 agent 引用了什么）
    let finalEvidence: Evidence[] = [];
    // P0-A·T1：自校验结果记 trace（与 ask 管线同款 reflection span），供观测反思的真实收益。
    // 用对象持有而非裸 let：赋值只发生在 sendEvent 闭包里，裸 let 会被 TS 的控制流分析
    // 一路窄化成 null（读取处进而变成 never）；属性访问在跨过 await 后会失效重来，类型才对。
    const reflectionRef: { meta: ReflectionSpanMeta | null } = { meta: null };
    // P1-C：执行计划单独落 meta（不进 steps——前端按独立卡片渲染，刷新/切会话后可还原）
    let planSteps: string[] | undefined;
    // 被拦下的内部 done：由路由在终态编排完成后统一下发（唯一一次）。
    // 用对象持有而非裸 let——赋值只发生在 sendEvent 闭包里，裸 let 会被 TS 窄化成 never。
    const doneRef: { event: AgentEvent | null } = { event: null };

    const sendEvent = (event: AgentEvent) => {
      if (event.type === 'plan') {
        planSteps = event.data.planSteps;
      } else if (event.type === 'thinking') {
        steps.push({ type: 'thinking', thought: event.data.thought });
      } else if (event.type === 'tool_call') {
        steps.push({ type: 'tool_call', toolName: event.data.toolName, toolArgs: event.data.toolArgs });
      } else if (event.type === 'tool_result') {
        steps.push({ type: 'tool_result', toolResult: event.data.toolResult });
      } else if (event.type === 'reflecting') {
        // 自查未通过、开始重答：记开始时刻，span 的耗时才有意义
        reflectionRef.meta = { citationAccuracy: event.data.citationAccuracy, retried: true, startedAt: Date.now() };
      } else if (event.type === 'done') {
        finalAnswer = event.data.answer ?? finalAnswer;
        finalFollowUp = event.data.followUp ?? finalFollowUp;
        finalEvidence = event.data.evidence ?? finalEvidence;
        reflectionRef.meta = {
          citationAccuracy: event.data.citationAccuracy,
          retried: event.data.reflectionRetried ?? false,
          startedAt: reflectionRef.meta?.startedAt,
        };
        // ★ 拦下内部 done 不下发：必须先落库 message、登记后台任务、终结 turn，
        // 再由路由发出**唯一一次**带成本汇总的 done（设计文档 §6.3/§12.2）。
        // 否则会出现"done 已发给前端、后台任务随后才登记"的竞态，汇总永远缺一块。
        doneRef.event = event;
        return;
      }
      // 断连后不再写死 socket（事件仍计入 steps，供中止前已产生轨迹的落库语义不变）
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await agentLoop({
        question: q,
        history: memoryBlock ? [{ role: 'system' as const, content: memoryBlock }, ...history] : history,
        graphStore,
        repoPath: currentRepoPath,
        onEvent: sendEvent,
        signal: abortCtl.signal,
        usage: { tracker: usageTracker },
        llm: {
          provider: getCurrentLlmProvider(),
          model: getCurrentLlmModel(),
          baseUrl: getCurrentLlmBaseUrl(),
          apiKey: LLM_API_KEY,
          maxTokens: LLM_MAX_TOKENS,
        },
      });
    } catch (err) {
      trace.error(err);
      sendEvent({
        type: 'error',
        data: { error: `Agent 异常: ${err instanceof Error ? err.message : String(err)}` },
      });
    }

    trace.span('agent_loop', tLoop, { steps: steps.length });
    // 反思观测（P0-A·T1）：只要跑完一次收尾就记，pass 与否都有数——
    // 没有这条就只能看到"重答过的那些"，算不出反思的触发率
    const reflection = reflectionRef.meta;
    if (reflection) {
      trace.span('reflection', reflection.startedAt ?? Date.now(), {
        citationAccuracy: reflection.citationAccuracy ?? null,
        retried: reflection.retried,
      });
    }
    // 中止收尾：观测记 cancelled（与 ask 管线同款语义），不算成功完成
    if (abortCtl.signal.aborted) trace.error(new Error('client_cancelled'));
    trace.end({ answer: finalAnswer, evidence: finalEvidence, intent: 'AGENT', confidence: 1, answeredByLlm: true });

    // ====== 终态编排（设计文档 §6.3）：落库 → 登记后台任务 → 终结 turn → 发唯一 done ======
    // 顺序不可调换：先发 done 会让后台任务的成本永远进不了这一轮的汇总。
    let memoryJob: ReturnType<typeof usageTracker.registerBackground> | null = null;
    let assistantMessageId: string | null = null;
    if (convId && finalAnswer) {
      try {
        assistantMessageId = appendMessage(convId, {
          role: 'assistant',
          content: finalAnswer,
          mode: 'agent',
          meta: { followUp: finalFollowUp, steps, ...(planSteps ? { planSteps } : {}) },
        }).id;
      } catch (err) {
        app.log.error(`对话持久化(回答)失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 中止后不再登记新的回答后任务（设计文档 §6.2）
      if (!abortCtl.signal.aborted) memoryJob = usageTracker.registerBackground('background.memory_extract');
    }

    const executionStatus = abortCtl.signal.aborted ? 'aborted' : finalAnswer ? 'completed' : 'failed';
    const usageSummary = usageTracker.finish(executionStatus);
    // 刷新会话后成本摘要仍在（meta 用 patch 合并，不覆盖 followUp/steps/planSteps）
    if (assistantMessageId) {
      try {
        setAssistantMessageId(usageTracker.turnId, assistantMessageId);
        updateMessageMeta(assistantMessageId, { tokenUsageSummary: usageSummary });
      } catch (err) {
        app.log.warn(`成本汇总回写失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const bufferedDone = doneRef.event;
    if (bufferedDone && !reply.raw.writableEnded) {
      const enriched: AgentEvent = {
        type: 'done',
        data: { ...bufferedDone.data, turnId: usageTracker.turnId, tokenUsageSummary: usageSummary },
      };
      reply.raw.write(`data: ${JSON.stringify(enriched)}\n\n`);
    }

    // 后台任务在对外 done 之后才启动：SSE 不为等待后台任务而保持连接
    if (memoryJob && convId && finalAnswer) {
      void generateMemoriesFromTurn(projectId, convId, q, finalAnswer, memoryJob.usageContext)
        .then(() => memoryJob!.done())
        .catch(() => memoryJob!.done({ status: 'failed' }));
    }

    reply.raw.end();
  });
}
