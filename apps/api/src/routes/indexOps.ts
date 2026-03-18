import type { FastifyInstance } from 'fastify';
import path from 'path';
import {
  graphStore,
  currentRepoName,
  metaData,
  indexTaskState,
} from '../context.js';
import {
  loadGraph,
  executeIndexBuild,
  normalizeScanPaths,
  patchIndexTaskState,
} from '../services/indexService.js';

export function registerIndexOps(app: FastifyInstance): void {
  app.get('/api/index/status', async () => {
    if (indexTaskState.status === 'building') {
      return {
        status: 'building',
        repoName: indexTaskState.repoName ?? currentRepoName ?? '',
        progress: indexTaskState.progress,
        phase: indexTaskState.phase,
        message: indexTaskState.message,
        startedAt: indexTaskState.startedAt,
        totalFiles: metaData?.totalFiles ?? 0,
        totalNodes: metaData?.totalNodes ?? 0,
        totalEdges: metaData?.totalEdges ?? 0,
      };
    }

    if (!graphStore || !metaData) {
      return {
        status: indexTaskState.status,
        repoName: currentRepoName ?? '',
        totalFiles: 0,
        totalNodes: 0,
        totalEdges: 0,
        progress: indexTaskState.progress,
        phase: indexTaskState.phase,
        message: indexTaskState.message,
        error: indexTaskState.error,
      };
    }

    return {
      status: indexTaskState.status === 'error' ? 'error' : 'ready',
      repoName: currentRepoName ?? '',
      lastBuildTime: metaData.buildTime ?? metaData.scanTime,
      totalFiles: metaData.totalFiles,
      totalNodes: metaData.totalNodes,
      totalEdges: metaData.totalEdges,
      resolveRate: metaData.resolveRate,
      progress: indexTaskState.progress,
      phase: indexTaskState.phase,
      message: indexTaskState.message,
      error: indexTaskState.error,
    };
  });

  app.get('/api/index/meta', async () => {
    if (!metaData) {
      return {
        repoName: '',
        scanTime: '',
        totalFiles: 0,
        totalNodes: 0,
        totalEdges: 0,
        failedFiles: [],
      };
    }
    return metaData;
  });

  app.post('/api/index/reload', async (request) => {
    const { repoName } = (request.body as { repoName?: string }) || {};
    const success = loadGraph(repoName ?? undefined, app.log);
    if (success) {
      patchIndexTaskState({
        status: 'ready',
        mode: null,
        repoName: currentRepoName,
        progress: 100,
        phase: 'done',
        message: '图谱重新加载成功',
        finishedAt: new Date().toISOString(),
        error: null,
      });
      return { message: '图谱重新加载成功', repoName: currentRepoName };
    }
    patchIndexTaskState({
      status: 'error',
      phase: 'error',
      message: '图谱重新加载失败',
      finishedAt: new Date().toISOString(),
      error: 'RELOAD_FAILED',
    });
    return { error: 'RELOAD_FAILED', message: '图谱重新加载失败' };
  });

  app.post('/api/index/build', async (request) => {
    if (indexTaskState.status === 'building') {
      return {
        error: 'INDEX_BUILD_RUNNING',
        message: '已有索引任务在运行中',
        status: indexTaskState,
      };
    }

    const body = (request.body as { repoPath?: string; repoName?: string; scanPaths?: string[] }) || {};
    const repoPath = body.repoPath || process.env.REPO_PATH;
    if (!repoPath) {
      return {
        error: 'REPO_PATH_MISSING',
        message: '请先在 .env 中配置 REPO_PATH',
      };
    }

    const repoName = body.repoName || process.env.REPO_NAME || path.basename(path.resolve(repoPath));
    const scanPaths = normalizeScanPaths(body.scanPaths);
    void executeIndexBuild({ repoPath, repoName, scanPaths, mode: 'full' }, app.log);
    return {
      message: '全量索引构建任务已提交',
      status: 'building',
      repoName,
      scanPaths,
    };
  });

  app.post('/api/index/rebuild', async (request) => {
    if (indexTaskState.status === 'building') {
      return {
        error: 'INDEX_BUILD_RUNNING',
        message: '已有索引任务在运行中',
        status: indexTaskState,
      };
    }

    const body = (request.body as { repoPath?: string; repoName?: string; scanPaths?: string[] }) || {};
    const repoPath = body.repoPath || process.env.REPO_PATH;
    if (!repoPath) {
      return {
        error: 'REPO_PATH_MISSING',
        message: '请先在 .env 中配置 REPO_PATH',
      };
    }

    const repoName = body.repoName || process.env.REPO_NAME || path.basename(path.resolve(repoPath));
    const scanPaths = normalizeScanPaths(body.scanPaths);
    void executeIndexBuild({ repoPath, repoName, scanPaths, mode: 'incremental' }, app.log);
    return {
      message: '增量重建任务已提交（当前按全量流程执行）',
      status: 'building',
      repoName,
      scanPaths,
    };
  });
}
