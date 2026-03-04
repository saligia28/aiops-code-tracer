import fs from 'fs';
import path from 'path';
import { collectFiles } from '@aiops/parser';
import { GraphStore } from '@aiops/graph-core';
import type { RepoConfig } from '@aiops/shared-types';

interface BuildOptions {
  repoPath: string;
  repoName: string;
  outputDir: string;
}

export async function buildIndex(options: BuildOptions): Promise<void> {
  const { repoPath, repoName, outputDir } = options;

  // 默认仓库配置
  const config: RepoConfig = {
    repoName,
    repoPath,
    scanPaths: ['src/views', 'src/components', 'src/store', 'src/router'],
    excludePaths: ['node_modules', 'dist', '*.spec.*', '*.test.*'],
    aliases: { '@': 'src' },
    autoImportDirs: ['src/hooks', 'src/assets/utils'],
    framework: 'vue3',
    stateManagement: 'vuex',
    scriptStyle: 'mixed',
  };

  // Step 1: 收集文件
  console.log('Step 1: 收集文件...');
  const files = await collectFiles(config);
  console.log(`  找到 ${files.length} 个文件`);

  // Step 2: 构建图谱
  console.log('Step 2: 构建图谱...');
  const graph = new GraphStore();

  // TODO: 遍历文件，AST 解析，提取节点和边
  for (const file of files) {
    graph.addNode({
      id: `file:${file}:${path.basename(file)}`,
      type: 'file',
      name: path.basename(file),
      filePath: file,
      loc: '1:1',
    });
  }

  console.log(`  节点数: ${graph.nodeCount}`);
  console.log(`  边数: ${graph.edgeCount}`);

  // Step 3: 输出索引
  console.log('Step 3: 输出索引...');
  const repoOutputDir = path.join(outputDir, repoName);
  fs.mkdirSync(repoOutputDir, { recursive: true });

  const graphData = graph.toJSON();
  graphData.meta.repoName = repoName;

  fs.writeFileSync(
    path.join(repoOutputDir, 'graph.json'),
    JSON.stringify(graphData, null, 2)
  );

  fs.writeFileSync(
    path.join(repoOutputDir, 'meta.json'),
    JSON.stringify(graphData.meta, null, 2)
  );

  console.log(`  索引已写入: ${repoOutputDir}`);
}
