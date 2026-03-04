#!/usr/bin/env node

import { Command } from 'commander';
import path from 'path';
import { buildIndex } from './buildIndex.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const program = new Command();

program
  .name('aiops-indexer')
  .description('代码智能分析平台 — 索引构建工具')
  .version('0.1.0');

program
  .command('index')
  .description('对目标仓库执行全量索引构建')
  .requiredOption('--repo <path>', '目标仓库路径')
  .option('--name <name>', '仓库名称（默认取目录名）')
  .option('--output <path>', '索引输出目录', './data/.aiops')
  .action(async (options) => {
    const repoPath = options.repo;
    const repoName = options.name || path.basename(repoPath);
    const outputDir = options.output;

    console.log(`开始索引构建...`);
    console.log(`  仓库路径: ${repoPath}`);
    console.log(`  仓库名称: ${repoName}`);
    console.log(`  输出目录: ${outputDir}`);

    try {
      await buildIndex({ repoPath, repoName, outputDir });
      console.log('索引构建完成!');
    } catch (err) {
      console.error('索引构建失败:', err);
      process.exit(1);
    }
  });

program.parse();
