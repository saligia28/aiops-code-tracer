import fs from 'fs';
import path from 'path';
import type { RepoConfig } from '@aiops/shared-types';
import { collectFiles, buildGraph } from '@aiops/parser';
import type { BuildStats } from '@aiops/parser';

const BATCH_SIZE = 50;

export interface PipelineProgress {
  phase: 'collect' | 'parse' | 'resolve' | 'output';
  current: number;
  total: number;
  file?: string;
}

/**
 * 完整索引构建管线
 */
export async function runPipeline(
  config: RepoConfig,
  outputDir: string,
  onProgress?: (progress: PipelineProgress) => void
): Promise<BuildStats> {
  // Phase 1: 收集文件
  onProgress?.({ phase: 'collect', current: 0, total: 0 });
  const files = await collectFiles(config);
  onProgress?.({ phase: 'collect', current: files.length, total: files.length });

  // Phase 2 & 3: 解析 + 跨文件解析 + 构建索引
  const result = buildGraph(files, config, (current, total, file) => {
    onProgress?.({ phase: 'parse', current, total, file });
  });

  // Phase 4: 输出产物
  onProgress?.({ phase: 'output', current: 0, total: 6 });
  const repoOutputDir = path.join(outputDir, config.repoName);
  fs.mkdirSync(repoOutputDir, { recursive: true });

  // graph.json
  const graphData = result.graph.toJSON();
  graphData.meta.repoName = config.repoName;
  graphData.meta.failedFiles = result.stats.failedFiles;
  fs.writeFileSync(
    path.join(repoOutputDir, 'graph.json'),
    JSON.stringify(graphData, null, 2)
  );
  onProgress?.({ phase: 'output', current: 1, total: 6 });

  // symbolIndex.json
  fs.writeFileSync(
    path.join(repoOutputDir, 'symbolIndex.json'),
    JSON.stringify(result.symbolIndex, null, 2)
  );
  onProgress?.({ phase: 'output', current: 2, total: 6 });

  // fileIndex.json
  fs.writeFileSync(
    path.join(repoOutputDir, 'fileIndex.json'),
    JSON.stringify(result.fileIndex, null, 2)
  );
  onProgress?.({ phase: 'output', current: 3, total: 6 });

  // apiIndex.json
  fs.writeFileSync(
    path.join(repoOutputDir, 'apiIndex.json'),
    JSON.stringify(result.apiIndex, null, 2)
  );
  onProgress?.({ phase: 'output', current: 4, total: 6 });

  // routeIndex.json
  fs.writeFileSync(
    path.join(repoOutputDir, 'routeIndex.json'),
    JSON.stringify(result.routeIndex, null, 2)
  );
  onProgress?.({ phase: 'output', current: 5, total: 6 });

  // meta.json
  const meta = {
    ...graphData.meta,
    resolvedRefs: result.stats.resolvedRefs,
    unresolvedRefs: result.stats.unresolvedRefs,
    totalRefs: result.stats.totalRefs,
    resolveRate: result.stats.resolveRate,
    duration: result.stats.duration,
    buildTime: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(repoOutputDir, 'meta.json'),
    JSON.stringify(meta, null, 2)
  );
  onProgress?.({ phase: 'output', current: 6, total: 6 });

  return result.stats;
}
