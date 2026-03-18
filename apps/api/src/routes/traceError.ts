import type { FastifyInstance } from 'fastify';

export function registerTraceError(app: FastifyInstance): void {
  app.post('/api/trace-error', async (request) => {
    const { error, file, line } = request.body as { error: string; file?: string; line?: number };
    // TODO: 根据错误信息定位相关代码上下文
    return {
      error,
      file: file ?? '',
      line: line ?? 0,
      context: [],
      relatedFunctions: [],
      possibleCauses: [],
    };
  });
}
