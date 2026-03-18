import type { FastifyInstance } from 'fastify';
import {
  buildLlmRuntimeConfig,
  hydrateLlmRuntimeConfig,
  updateLlmRuntimeConfig,
} from '../services/llmService.js';

export function registerLlm(app: FastifyInstance): void {
  app.get('/api/llm/config', async () => {
    return hydrateLlmRuntimeConfig(buildLlmRuntimeConfig());
  });

  app.post('/api/llm/config', async (request, reply) => {
    const body = (request.body as { mode?: string; model?: string } | undefined) || {};
    if (body.mode && body.mode !== 'api' && body.mode !== 'intranet') {
      return reply.code(400).send({ error: 'INVALID_MODE', message: 'mode 仅支持 api 或 intranet' });
    }

    return hydrateLlmRuntimeConfig(updateLlmRuntimeConfig(body));
  });
}
