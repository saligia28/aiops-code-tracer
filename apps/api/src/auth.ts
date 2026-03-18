import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import {
  AUTH_PASSWORD,
  AUTH_SECRET,
  AUTH_COOKIE,
  AUTH_MAX_AGE_S,
} from './context.js';

function generateToken(password: string): string {
  return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

function verifyToken(token: string): boolean {
  if (!AUTH_PASSWORD) return true;
  return token === generateToken(AUTH_PASSWORD);
}

const PUBLIC_ROUTES = ['/api/health', '/api/auth/login', '/api/auth/status'];

export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!AUTH_PASSWORD) return;
    const routePath = request.url.split('?')[0];
    if (PUBLIC_ROUTES.includes(routePath)) return;
    // WebSocket 升级也走此钩子
    const token = request.cookies[AUTH_COOKIE];
    if (!token || !verifyToken(token)) {
      reply.code(401).send({ message: '未授权，请先登录' });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!AUTH_PASSWORD) {
      return { ok: true, message: '认证未启用' };
    }
    const { password } = request.body as { password?: string };
    if (!password || password !== AUTH_PASSWORD) {
      reply.code(401).send({ message: '密码错误' });
      return;
    }
    const token = generateToken(password);
    reply.setCookie(AUTH_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: AUTH_MAX_AGE_S,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/status', async (request) => {
    if (!AUTH_PASSWORD) {
      return { authenticated: true, authEnabled: false };
    }
    const token = request.cookies[AUTH_COOKIE];
    const authenticated = !!token && verifyToken(token);
    return { authenticated, authEnabled: true };
  });
}
