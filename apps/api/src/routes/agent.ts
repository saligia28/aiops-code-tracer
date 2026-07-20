import type { FastifyInstance } from 'fastify';
import type { AgentEvent } from '@aiops/shared-types';
import { graphStore, currentRepoPath, currentRepoName, resolveActiveProjectId, LLM_API_KEY, LLM_MAX_TOKENS } from '../context.js';
import { startAskTrace } from '../services/traceService.js';
import { agentLoop } from '../agent/index.js';
import { getCurrentLlmProvider, getCurrentLlmModel, getCurrentLlmBaseUrl } from '../services/llmService.js';
import { createConversation, getConversationForProject, appendMessage } from '../db/conversationStore.js';
import { buildHistoryWindow } from '../services/ask/historyCompactor.js';
import { retrieveMemoryBlock, generateMemoriesFromTurn } from '../services/memoryService.js';
import { getContextBudgets } from '../services/ask/contextBudget.js';

export function registerAgent(app: FastifyInstance): void {
  app.post('/api/agent/ask', async (request, reply) => {
    const { question, conversationId } = request.body as { question?: string; conversationId?: string };
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
    let history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
    try {
      // 归属校验（review 修复）：跨项目/失效的 conversationId 视作无效 → 新建会话
      const conv = (conversationId ? getConversationForProject(conversationId, projectId) : null) ?? createConversation(projectId, q.slice(0, 40));
      convId = conv.id;
      // P2-H：超预算历史用 LLM 摘要顶上（后台生成，当轮零延迟），短会话行为与纯截断一致
      history = buildHistoryWindow(convId, getContextBudgets().history, (err) =>
        app.log.error(`历史摘要压缩失败: ${err instanceof Error ? err.message : String(err)}`),
      );
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
    const tLoop = Date.now();

    // 累积 agent 轨迹与最终答案，用于落库
    const steps: Array<Record<string, unknown>> = [];
    let finalAnswer = '';
    let finalFollowUp: string[] = [];

    const sendEvent = (event: AgentEvent) => {
      if (event.type === 'thinking') {
        steps.push({ type: 'thinking', thought: event.data.thought });
      } else if (event.type === 'tool_call') {
        steps.push({ type: 'tool_call', toolName: event.data.toolName, toolArgs: event.data.toolArgs });
      } else if (event.type === 'tool_result') {
        steps.push({ type: 'tool_result', toolResult: event.data.toolResult });
      } else if (event.type === 'done') {
        finalAnswer = event.data.answer ?? finalAnswer;
        finalFollowUp = event.data.followUp ?? finalFollowUp;
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
    // 中止收尾：观测记 cancelled（与 ask 管线同款语义），不算成功完成
    if (abortCtl.signal.aborted) trace.error(new Error('client_cancelled'));
    trace.end({ answer: finalAnswer, evidence: [], intent: 'AGENT', confidence: 1, answeredByLlm: true });

    // 落库 assistant 消息（含 agent 轨迹）
    if (convId && finalAnswer) {
      try {
        appendMessage(convId, {
          role: 'assistant',
          content: finalAnswer,
          mode: 'agent',
          meta: { followUp: finalFollowUp, steps },
        });
      } catch (err) {
        app.log.error(`对话持久化(回答)失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 后台沉淀记忆（fire-and-forget）
      void generateMemoriesFromTurn(projectId, convId, q, finalAnswer);
    }

    reply.raw.end();
  });
}
