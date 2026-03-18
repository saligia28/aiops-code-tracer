import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';

export function registerFs(app: FastifyInstance): void {
  app.get('/api/fs/dirs', async (request, reply) => {
    const query = request.query as { path?: string };
    const os = await import('os');
    const targetPath = query.path?.trim() || os.default.homedir();
    const resolved = path.resolve(targetPath);

    if (!fs.existsSync(resolved)) {
      return reply.code(404).send({ error: 'PATH_NOT_FOUND', message: `路径不存在: ${resolved}` });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: 'NOT_A_DIRECTORY', message: `不是目录: ${resolved}` });
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

      const isGitRepo = fs.existsSync(path.join(resolved, '.git'));
      const hasPackageJson = fs.existsSync(path.join(resolved, 'package.json'));

      return {
        current: resolved,
        parent: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
        dirs,
        isGitRepo,
        hasPackageJson,
      };
    } catch {
      return reply.code(403).send({ error: 'ACCESS_DENIED', message: `无法读取目录: ${resolved}` });
    }
  });
}
