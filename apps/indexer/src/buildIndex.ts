import path from 'path';
import type { RepoConfig } from '@aiops/shared-types';
import { runPipeline } from './pipeline.js';

interface BuildOptions {
  repoPath: string;
  repoName: string;
  outputDir: string;
  scanPaths?: string[];
}

export async function buildIndex(options: BuildOptions): Promise<void> {
  const { repoPath, repoName, outputDir, scanPaths } = options;

  const config: RepoConfig = {
    repoName,
    repoPath,
    scanPaths: scanPaths ?? ['src'],
    excludePaths: ['node_modules', 'dist', '*.spec.*', '*.test.*'],
    aliases: { '@': 'src' },
    autoImportDirs: ['src/hooks', 'src/assets/utils'],
    framework: 'vue3',
    stateManagement: 'vuex',
    scriptStyle: 'mixed',
  };

  const absoluteOutputDir = path.isAbsolute(outputDir)
    ? outputDir
    : path.resolve(process.cwd(), outputDir);

  const stats = await runPipeline(config, absoluteOutputDir, (progress) => {
    switch (progress.phase) {
      case 'collect':
        if (progress.total > 0) {
          console.log(`[收集] 找到 ${progress.total} 个文件`);
        }
        break;
      case 'parse':
        if (progress.current % 50 === 0 || progress.current === progress.total) {
          console.log(`[解析] ${progress.current}/${progress.total} ${progress.file ?? ''}`);
        }
        break;
      case 'output':
        if (progress.current === progress.total) {
          console.log(`[输出] ${progress.total} 个产物文件已写入`);
        }
        break;
    }
  });

  console.log('\n===== 构建统计 =====');
  console.log(`文件总数: ${stats.totalFiles}`);
  console.log(`解析成功: ${stats.parsedFiles}`);
  console.log(`解析失败: ${stats.failedFiles.length}`);
  console.log(`节点总数: ${stats.totalNodes}`);
  console.log(`边总数:   ${stats.totalEdges}`);
  console.log(`引用总数: ${stats.totalRefs}`);
  console.log(`已解析:   ${stats.resolvedRefs}`);
  console.log(`未解析:   ${stats.unresolvedRefs}`);
  console.log(`解析率:   ${stats.resolveRate}`);
  console.log(`耗时:     ${stats.duration}ms`);

  if (stats.failedFiles.length > 0) {
    console.log(`\n失败文件:`);
    for (const f of stats.failedFiles) {
      console.log(`  - ${f}`);
    }
  }
}
