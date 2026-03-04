import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

// ============================================================
// 健康检查
// ============================================================
app.get('/api/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// ============================================================
// 自然语言问答（主入口）
// ============================================================
app.post('/api/ask', async (request, reply) => {
  const { question } = request.body as { question: string };
  // TODO: 接入 NLP 管线
  return {
    answer: `[MVP 占位] 收到问题: "${question}"`,
    evidence: [],
    graph: { nodes: [], edges: [] },
    intent: 'GENERAL',
    confidence: 0,
    followUp: [],
  };
});

// ============================================================
// 符号追踪
// ============================================================
app.get('/api/trace', async (request) => {
  const { symbol, depth } = request.query as { symbol: string; depth?: string };
  // TODO: 接入 graph-core 追踪
  return { symbol, depth: Number(depth) || 3, nodes: [], edges: [] };
});

// ============================================================
// 反向追踪
// ============================================================
app.get('/api/why', async (request) => {
  const { target, depth } = request.query as { target: string; depth?: string };
  // TODO: 接入 graph-core 反向追踪
  return { target, depth: Number(depth) || 3, nodes: [], edges: [] };
});

// ============================================================
// 模糊搜索
// ============================================================
app.get('/api/search', async (request) => {
  const { q } = request.query as { q: string };
  // TODO: 接入 graph-core 搜索
  return { query: q, results: [] };
});

// ============================================================
// 索引状态
// ============================================================
app.get('/api/index/status', async () => {
  // TODO: 读取索引元信息
  return { status: 'idle', repoName: '', totalFiles: 0, totalNodes: 0, totalEdges: 0 };
});

// ============================================================
// 索引扫描元信息
// ============================================================
app.get('/api/index/meta', async () => {
  // TODO: 读取 meta.json
  return {
    repoName: '',
    scanTime: '',
    totalFiles: 0,
    totalNodes: 0,
    totalEdges: 0,
    failedFiles: [],
    scanDuration: 0,
  };
});

// ============================================================
// 触发索引构建
// ============================================================
app.post('/api/index/build', async () => {
  // TODO: 触发 indexer 任务
  return { message: '索引构建任务已提交' };
});

// ============================================================
// 增量重建
// ============================================================
app.post('/api/index/rebuild', async () => {
  // TODO: 基于 git diff 增量重建
  return { message: '增量重建任务已提交' };
});

// ============================================================
// 图谱统计
// ============================================================
app.get('/api/graph/stats', async () => {
  // TODO: 读取图谱统计
  return { totalNodes: 0, totalEdges: 0, nodeTypes: {}, edgeTypes: {} };
});

// ============================================================
// 按文件查询图谱子集
// ============================================================
app.get('/api/graph/file', async (request) => {
  const { path } = request.query as { path: string };
  // TODO: 接入 graph-core 按文件查询
  return { file: path, nodes: [], edges: [] };
});

// ============================================================
// 按符号查询图谱子集
// ============================================================
app.get('/api/graph/symbol', async (request) => {
  const { name } = request.query as { name: string };
  // TODO: 接入 graph-core 按符号查询
  return { symbol: name, nodes: [], edges: [] };
});

// ============================================================
// 模块级概览图
// ============================================================
app.get('/api/graph/module', async (request) => {
  const { name } = request.query as { name: string };
  // TODO: 按模块名查询图谱子集
  return { module: name, nodes: [], edges: [] };
});

// ============================================================
// 报错追踪
// ============================================================
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
