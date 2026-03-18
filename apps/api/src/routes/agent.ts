import type { FastifyInstance } from 'fastify';
import type { AgentEvent } from '@aiops/shared-types';
import { graphStore, REPO_PATH_ENV, LLM_API_KEY, LLM_MAX_TOKENS } from '../context.js';
import { agentLoop } from '../agent/index.js';
import { getCurrentLlmProvider, getCurrentLlmModel, getCurrentLlmBaseUrl } from '../services/llmService.js';

export function registerAgent(app: FastifyInstance): void {
  app.post('/api/agent/ask', async (request, reply) => {
    const { question } = request.body as { question?: string };
    if (!question?.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
    }

    if (!graphStore) {
      return reply.code(503).send({ error: 'GRAPH_NOT_LOADED', message: '图谱未加载，请先运行索引构建' });
    }

    // SSE 响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: AgentEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await agentLoop({
        question: question.trim(),
        graphStore,
        repoPath: REPO_PATH_ENV,
        onEvent: sendEvent,
        llm: {
          provider: getCurrentLlmProvider(),
          model: getCurrentLlmModel(),
          baseUrl: getCurrentLlmBaseUrl(),
          apiKey: LLM_API_KEY,
          maxTokens: LLM_MAX_TOKENS,
        },
      });
    } catch (err) {
      sendEvent({
        type: 'error',
        data: { error: `Agent 异常: ${err instanceof Error ? err.message : String(err)}` },
      });
    }

    reply.raw.end();
  });
}
