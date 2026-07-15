/**
 * 评测通道 · 运行骨架
 *
 * 把「加载图 → 跑召回 → 收集产出 → 打分 → 聚合 → 格式化」这段脏活封装掉，
 * 让 vitest 门禁（retrieval.eval.test.ts）和独立报表（run.ts）共用一套逻辑。
 *
 * 关键点：findRelevantNodes 依赖 context.ts 里的模块级状态
 * （graphStore / recallIndex / fileRecallIndex / fileNodeMap），
 * 所以评测前必须先 loadEvalGraph() 把一张真实的图灌进去。
 * 这条路径纯离线：buildRecallIndex 系列都是本地 TF-IDF，不触网、不需要 API key。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, buildGraph } from '@aiops/parser';
import type { RepoConfig, GraphNode } from '@aiops/shared-types';
import {
  DATA_DIR,
  setGraphStore,
  setFileNodeMap,
  setCurrentRepoPath,
  setCurrentRepoName,
} from '../../src/context.ts';
import { loadGraph } from '../../src/services/indexService.ts';
import { buildRecallIndex, buildFileRecallIndex, buildFactIndex } from '../../src/services/ask/indexing.ts';
import { findRelevantNodes } from '../../src/services/ask/recall.ts';
import { recallAtK, firstHitRank, reciprocalRank, mean } from './metrics.ts';
import type { RetrievalCase, RetrievalOutcome, CaseScore, AggregateReport } from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** data/.aiops/<repo>/graph.json 是否存在（该目录被 gitignore，CI 上可能没有）。 */
export function graphExists(repo: string): boolean {
  return fs.existsSync(path.join(DATA_DIR, repo, 'graph.json'));
}

/**
 * 把指定仓库的图 + 召回索引灌入全局状态（复用生产同一条 loadGraph 路径）。
 * @param repo data/.aiops 下的目录名，默认 'elink-pc'（前端业务库，中文域词丰富）
 */
export function loadEvalGraph(repo = 'elink-pc'): void {
  if (!graphExists(repo)) {
    throw new Error(
      `[eval] 找不到 ${path.join(DATA_DIR, repo, 'graph.json')}\n` +
        `      先构建索引，或换一个已索引的 repo（elink-pc / quality / main-java）。`,
    );
  }
  if (!loadGraph(repo)) {
    throw new Error(`[eval] loadGraph('${repo}') 返回 false，图谱加载失败。`);
  }
}

/**
 * 从随仓库提交的 fixture 仓库（test/eval/fixture-repo）现场建图并灌入全局状态。
 * 与 loadEvalGraph 的区别：不依赖 data/.aiops（gitignored）——这条路径让检索门禁
 * 在 CI 上真实运行而不是 skip（P0-1 修复）。全程内存态，不写任何磁盘产物。
 */
export async function loadFixtureGraph(): Promise<void> {
  const repoPath = path.join(HERE, 'fixture-repo');
  const config: RepoConfig = {
    repoName: 'eval-fixture',
    repoPath,
    scanPaths: ['src'],
    excludePaths: [],
    aliases: { '@': 'src' },
    autoImportDirs: [],
    framework: 'vue3',
    stateManagement: 'none',
    scriptStyle: 'options',
  };
  const files = await collectFiles(config);
  if (files.length === 0) throw new Error('[eval] fixture 仓库没有可解析文件');
  const result = await buildGraph(files, config, () => {});

  setGraphStore(result.graph);
  setCurrentRepoPath(repoPath);
  setCurrentRepoName('eval-fixture');

  const nodes = result.graph.toJSON().nodes;
  const fileNodeMap = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.type === 'file') continue;
    const list = fileNodeMap.get(node.filePath) ?? [];
    list.push(node);
    fileNodeMap.set(node.filePath, list);
  }
  setFileNodeMap(fileNodeMap);
  buildRecallIndex(nodes, 'eval-fixture');
  buildFileRecallIndex('eval-fixture');
  buildFactIndex('eval-fixture');
}

/** 读 JSONL 数据集（每行一个 JSON 对象；空行与 '#' 开头的注释行跳过）。 */
export function loadJsonl<T>(relPath: string): T[] {
  const abs = path.join(HERE, relPath);
  const raw = fs.readFileSync(abs, 'utf-8');
  const out: T[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      throw new Error(`[eval] 数据集第 ${i + 1} 行不是合法 JSON：${l}`);
    }
  });
  return out;
}

/** 去重保序：把召回节点压成文件序列（file 粒度判分用）。 */
export function toRetrievedFiles(nodes: Array<{ filePath: string }>): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const n of nodes) {
    if (seen.has(n.filePath)) continue;
    seen.add(n.filePath);
    files.push(n.filePath);
  }
  return files;
}

/**
 * 对一条用例跑一次检索，返回原始产出（不打分）。
 * maxResults=60 与生产 ask 路由一致；节点去重成文件后通常 ≥ K 个，够算 Recall@10。
 */
export function runRetrievalCase(c: RetrievalCase, maxResults = 60): RetrievalOutcome {
  const retrieved = findRelevantNodes(c.question, maxResults);
  return { case: c, retrieved, retrievedFiles: toRetrievedFiles(retrieved) };
}

/** 给一条产出打分。 */
export function scoreCase(o: RetrievalOutcome, k: number): CaseScore {
  const { case: c, retrievedFiles } = o;
  const rank = firstHitRank(retrievedFiles, c.expectedFiles);
  return {
    id: c.id,
    question: c.question,
    hit: rank !== null,
    rank,
    recallAtK: recallAtK(retrievedFiles, c.expectedFiles, k),
    reciprocalRank: reciprocalRank(retrievedFiles, c.expectedFiles),
  };
}

/** 把一批 CaseScore 聚合成报告。 */
export function aggregate(scores: CaseScore[], k: number): AggregateReport {
  return {
    total: scores.length,
    k,
    recallAtK: mean(scores.map((s) => s.recallAtK)),
    mrr: mean(scores.map((s) => s.reciprocalRank)),
    hitRate: scores.length ? scores.filter((s) => s.hit).length / scores.length : 0,
    scores,
  };
}

/** 渲染成给人看的文本报表。 */
export function formatReport(r: AggregateReport): string {
  const rows = r.scores.map(
    (s) =>
      `  ${s.hit ? '✅' : '❌'}  rank=${String(s.rank ?? '-').padStart(3)}  ` +
      `recall=${s.recallAtK.toFixed(2)}  ${s.question}`,
  );
  return [
    `用例=${r.total}  K=${r.k}`,
    ...rows,
    '',
    `  Recall@${r.k}=${r.recallAtK.toFixed(3)}   MRR=${r.mrr.toFixed(3)}   HitRate=${r.hitRate.toFixed(3)}`,
  ].join('\n');
}
