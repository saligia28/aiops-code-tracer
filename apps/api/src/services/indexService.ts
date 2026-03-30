import fs from 'fs';
import path from 'path';
import type { FastifyBaseLogger } from 'fastify';
import { GraphStore } from '@aiops/graph-core';
import type { CodeGraph, RepoConfig } from '@aiops/shared-types';
import { collectFiles, buildGraph } from '@aiops/parser';
import type { SymbolIndex, BuildResult } from '@aiops/parser';
import {
  DATA_DIR,
  REPO_PATH_ENV,
  graphStore,
  symbolIndex,
  currentRepoName,
  metaData,
  indexTaskState,
  progressClients,
  fileNodeMap,
  setGraphStore,
  setSymbolIndex,
  setCurrentRepoName,
  setMetaData,
  setCurrentRepoPath,
  setIndexTaskState,
  setFileNodeMap,
  setRecallIndex,
  setFileRecallIndex,
  setFactIndex,
  setPageAnchors,
  type IndexTaskState,
} from '../context.js';
import { sendAlert } from './alertService.js';
import { readProjectRegistry, writeProjectRegistry } from './projectService.js';
import {
  buildRecallIndex,
  buildFileRecallIndex,
  buildFactIndex,
  buildPageAnchorIndex,
} from './askService.js';

export function broadcastProgress(event: Record<string, unknown>): void {
  const payload = JSON.stringify(event);
  for (const client of progressClients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(payload);
    } catch {
      // noop
    }
  }
}

export function patchIndexTaskState(patch: Partial<IndexTaskState>): void {
  setIndexTaskState({ ...indexTaskState, ...patch });
  broadcastProgress({
    type: 'index-progress',
    ...indexTaskState,
    timestamp: new Date().toISOString(),
  });
}

export function normalizeScanPaths(scanPaths?: string[]): string[] {
  if (scanPaths && scanPaths.length > 0) {
    return scanPaths.map((p) => p.trim()).filter(Boolean);
  }

  if (process.env.INDEX_SCAN_PATHS) {
    return process.env.INDEX_SCAN_PATHS.split(',').map((p) => p.trim()).filter(Boolean);
  }

  return ['src'];
}

export function parseJsonRecordEnv(envName: string, log?: FastifyBaseLogger): Record<string, string> | undefined {
  const raw = process.env[envName];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch (err) {
    log?.warn(`${envName} 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

export function buildRepoConfig(repoPath: string, repoName: string, scanPaths?: string[], overrides?: {
  aliases?: Record<string, string>;
  autoImportDirs?: string[];
  framework?: string;
  stateManagement?: string;
}, log?: FastifyBaseLogger): RepoConfig {
  const envAliases = parseJsonRecordEnv('REPO_ALIASES', log);
  const envAutoImportDirs = process.env.REPO_AUTO_IMPORT_DIRS ? process.env.REPO_AUTO_IMPORT_DIRS.split(',').map((d) => d.trim()).filter(Boolean) : undefined;
  const envFramework = process.env.REPO_FRAMEWORK;
  const envStateManagement = process.env.REPO_STATE_MANAGEMENT;

  return {
    repoName,
    repoPath: path.resolve(repoPath),
    scanPaths: normalizeScanPaths(scanPaths),
    excludePaths: [
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
      '.next',
      '.nuxt',
      '*.spec.*',
      '*.test.*',
    ],
    aliases: overrides?.aliases ?? envAliases ?? { '@': 'src' },
    autoImportDirs: overrides?.autoImportDirs ?? envAutoImportDirs ?? ['src/hooks', 'src/assets/utils', 'src/static', 'src/store/browser'],
    framework: (overrides?.framework ?? envFramework ?? 'vue3') as RepoConfig['framework'],
    stateManagement: (overrides?.stateManagement ?? envStateManagement ?? 'vuex') as RepoConfig['stateManagement'],
    scriptStyle: 'mixed',
  };
}

export function persistBuildArtifacts(result: BuildResult, repoName: string): Record<string, unknown> {
  const repoOutputDir = path.join(DATA_DIR, repoName);
  fs.mkdirSync(repoOutputDir, { recursive: true });

  const graphData = result.graph.toJSON();
  graphData.meta.repoName = repoName;
  graphData.meta.failedFiles = result.stats.failedFiles;
  fs.writeFileSync(path.join(repoOutputDir, 'graph.json'), JSON.stringify(graphData, null, 2));

  fs.writeFileSync(path.join(repoOutputDir, 'symbolIndex.json'), JSON.stringify(result.symbolIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'fileIndex.json'), JSON.stringify(result.fileIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'apiIndex.json'), JSON.stringify(result.apiIndex, null, 2));
  fs.writeFileSync(path.join(repoOutputDir, 'routeIndex.json'), JSON.stringify(result.routeIndex, null, 2));

  const meta = {
    ...graphData.meta,
    resolvedRefs: result.stats.resolvedRefs,
    unresolvedRefs: result.stats.unresolvedRefs,
    totalRefs: result.stats.totalRefs,
    resolveRate: result.stats.resolveRate,
    duration: result.stats.duration,
    buildTime: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(repoOutputDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * 加载指定仓库的图谱数据
 */
export function loadGraph(repoName?: string, log?: FastifyBaseLogger): boolean {
  try {
    // 如果没有指定 repoName，自动发现第一个仓库目录
    if (!repoName) {
      if (!fs.existsSync(DATA_DIR)) return false;
      const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      if (dirs.length === 0) return false;
      repoName = dirs[0];
    }

    const repoDir = path.join(DATA_DIR, repoName);
    const graphPath = path.join(repoDir, 'graph.json');
    const symbolIndexPath = path.join(repoDir, 'symbolIndex.json');
    const metaPath = path.join(repoDir, 'meta.json');

    if (!fs.existsSync(graphPath)) {
      // 图谱不存在时清除旧数据，避免切换项目后仍使用上一个项目的图谱
      setGraphStore(null);
      setSymbolIndex(null);
      setRecallIndex(null);
      setFileRecallIndex(null);
      setFactIndex(null);
      setFileNodeMap(new Map());
      setPageAnchors([]);
      return false;
    }

    const graphData: CodeGraph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    setGraphStore(GraphStore.fromJSON(graphData));

    if (fs.existsSync(symbolIndexPath)) {
      setSymbolIndex(JSON.parse(fs.readFileSync(symbolIndexPath, 'utf-8')));
    }

    if (fs.existsSync(metaPath)) {
      setMetaData(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
    }

    setCurrentRepoName(repoName);

    // 从项目注册表中读取 repoPath，更新全局状态
    const projects = readProjectRegistry();
    const matchedProject = projects.find((p) => p.id === repoName);
    if (matchedProject?.repoPath) {
      setCurrentRepoPath(matchedProject.repoPath);
    }

    const newFileNodeMap = new Map<string, import('@aiops/shared-types').GraphNode[]>();
    for (const node of graphData.nodes) {
      if (node.type === 'file') continue;
      const list = newFileNodeMap.get(node.filePath) ?? [];
      list.push(node);
      newFileNodeMap.set(node.filePath, list);
    }
    setFileNodeMap(newFileNodeMap);
    buildRecallIndex(graphData.nodes, repoName, log);
    buildFileRecallIndex(repoName, log);
    buildFactIndex(repoName, log);
    buildPageAnchorIndex(log);
    log?.info(`图谱已加载: ${repoName} (${graphStore!.nodeCount} nodes, ${graphStore!.edgeCount} edges)`);
    return true;
  } catch (err) {
    setGraphStore(null);
    setSymbolIndex(null);
    setRecallIndex(null);
    setFileRecallIndex(null);
    setFactIndex(null);
    setFileNodeMap(new Map());
    setPageAnchors([]);
    log?.error(`加载图谱失败: ${err}`);
    return false;
  }
}

export async function executeIndexBuild(options: {
  repoPath: string;
  repoName: string;
  scanPaths?: string[];
  mode: 'full' | 'incremental';
}, log?: FastifyBaseLogger): Promise<void> {
  const { repoPath, repoName, scanPaths, mode } = options;
  const config = buildRepoConfig(repoPath, repoName, scanPaths);

  patchIndexTaskState({
    status: 'building',
    mode,
    repoName,
    progress: 0,
    phase: 'collect',
    message: '开始收集文件',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });
  await sendAlert(
    `索引任务开始 (${mode === 'incremental' ? '增量' : '全量'})`,
    [
      `仓库: ${repoName}`,
      `路径: ${config.repoPath}`,
      `扫描目录: ${config.scanPaths.join(', ')}`,
    ],
    'info',
    log
  );

  try {
    const files = await collectFiles(config);
    patchIndexTaskState({
      phase: 'collect',
      progress: 5,
      message: `收集完成，共 ${files.length} 个文件`,
    });

    const result = buildGraph(files, config, (current, total, file) => {
      const ratio = total > 0 ? current / total : 0;
      const progress = Math.min(90, 5 + Math.floor(ratio * 80));
      if (current % 20 === 0 || current === total) {
        patchIndexTaskState({
          phase: 'parse',
          progress,
          message: `解析进度 ${current}/${total}${file ? ` (${file})` : ''}`,
        });
      }
    });

    patchIndexTaskState({
      phase: 'output',
      progress: 95,
      message: '写入索引产物',
    });
    const meta = persistBuildArtifacts(result, repoName);

    const loaded = loadGraph(repoName, log);
    patchIndexTaskState({
      status: loaded ? 'ready' : 'error',
      phase: loaded ? 'done' : 'error',
      progress: loaded ? 100 : 95,
      message: loaded ? '索引构建完成并已加载' : '索引构建完成，但加载失败',
      finishedAt: new Date().toISOString(),
      error: loaded ? null : 'GRAPH_RELOAD_FAILED',
    });

    setMetaData(meta);
    await sendAlert(
      `索引任务完成 (${mode === 'incremental' ? '增量' : '全量'})`,
      [
        `仓库: ${repoName}`,
        `文件数: ${result.stats.totalFiles}`,
        `节点数: ${result.stats.totalNodes}`,
        `边数: ${result.stats.totalEdges}`,
        `引用解析率: ${result.stats.resolveRate}`,
        `耗时: ${result.stats.duration}ms`,
      ],
      'info',
      log
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log?.error(`索引构建失败: ${errorMessage}`);
    patchIndexTaskState({
      status: 'error',
      phase: 'error',
      message: '索引构建失败',
      finishedAt: new Date().toISOString(),
      error: errorMessage,
    });
    await sendAlert(
      `索引任务失败 (${mode === 'incremental' ? '增量' : '全量'})`,
      [
        `仓库: ${repoName}`,
        `路径: ${config.repoPath}`,
        `错误: ${errorMessage}`,
      ],
      'error',
      log
    );
  }
}

/**
 * 自动迁移：把已有图谱数据目录注册为项目
 */
export function migrateExistingGraphData(log?: FastifyBaseLogger): void {
  if (!fs.existsSync(DATA_DIR)) return;
  const projects = readProjectRegistry();
  const registeredIds = new Set(projects.map((p) => p.id));
  const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let changed = false;
  for (const dirName of dirs) {
    if (registeredIds.has(dirName)) continue;
    const graphPath = path.join(DATA_DIR, dirName, 'graph.json');
    if (!fs.existsSync(graphPath)) continue;

    const now = new Date().toISOString();
    projects.push({
      id: dirName,
      name: dirName,
      framework: 'vue3',
      repoPath: '',
      gitUrl: '',
      scanPaths: ['src'],
      createdAt: now,
      updatedAt: now,
    });
    changed = true;
    log?.info(`自动注册已有图谱: ${dirName}`);
  }

  if (changed) {
    writeProjectRegistry(projects);
  }
}
