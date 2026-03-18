import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import {
  graphStore,
  currentRepoName,
  indexTaskState,
  progressClients,
} from './context.js';
import { registerAuth } from './auth.js';
import { setLlmServiceLogger } from './services/llmService.js';
import { loadGraph, patchIndexTaskState, migrateExistingGraphData } from './services/indexService.js';

// 路由
import { registerHealth } from './routes/health.js';
import { registerProjects } from './routes/projects.js';
import { registerFs } from './routes/fs.js';
import { registerRepos } from './routes/repos.js';
import { registerLlm } from './routes/llm.js';
import { registerAsk } from './routes/ask.js';
import { registerTrace } from './routes/trace.js';
import { registerIndexOps } from './routes/indexOps.js';
import { registerGraph } from './routes/graph.js';
import { registerTraceError } from './routes/traceError.js';
import { registerAgent } from './routes/agent.js';

// ============================================================
// 创建应用 & 注册插件
// ============================================================

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
await app.register(websocket);

// 将 logger 注入需要它的 service
setLlmServiceLogger(app.log);

// ============================================================
// 认证 & 路由注册
// ============================================================

registerAuth(app);
registerHealth(app);
registerProjects(app);
registerFs(app);
registerRepos(app);
registerLlm(app);
registerAsk(app);
registerTrace(app);
registerIndexOps(app);
registerGraph(app);
registerTraceError(app);
registerAgent(app);

// ============================================================
// WebSocket 进度推送
// ============================================================

app.get('/ws/progress', { websocket: true }, (socket) => {
  progressClients.add(socket as { send: (payload: string) => void; readyState: number });

  try {
    socket.send(JSON.stringify({
      type: 'index-progress',
      ...indexTaskState,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // noop
  }

  socket.on('close', () => {
    progressClients.delete(socket as { send: (payload: string) => void; readyState: number });
  });
});

// ============================================================
// 启动时加载图谱
// ============================================================

const preferredRepoName = process.env.REPO_NAME?.trim();
const loadedOnStartup = preferredRepoName
  ? (loadGraph(preferredRepoName, app.log) || loadGraph(undefined, app.log))
  : loadGraph(undefined, app.log);

if (loadedOnStartup) {
  patchIndexTaskState({
    status: 'ready',
    mode: null,
    repoName: currentRepoName,
    progress: 100,
    phase: 'done',
    message: '已加载现有索引',
    startedAt: null,
    finishedAt: new Date().toISOString(),
    error: null,
  });
}

// 自动迁移已有图谱数据
migrateExistingGraphData(app.log);

// ============================================================
// 启动服务
// ============================================================

const port = Number(process.env.API_PORT) || 4201;

try {
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API server running at http://0.0.0.0:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
