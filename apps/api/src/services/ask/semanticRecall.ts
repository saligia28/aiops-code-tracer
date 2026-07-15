// ============================================================
// 语义召回通道（Gap B 修复）
// 用 embedding 把「问题」和「文件内容 profile」映射到同一向量空间，
// 靠中文↔中文的语义相似度，桥接词法过不去的「中文提问 × 英文标识符」。
//
// 为什么 embed 文件内容而不是节点名/路径：探针实测（bge-m3）
//   cos(中文问题, 文件内中文标签) = 0.72  >  cos(中文问题, 英文标识符) = 0.59
// —— 中文业务词（"核价状态"…）才是跨语言的桥；英文标识符桥不动。
//
// 索引是构建期产物（embedding 昂贵），持久化到 data/.aiops/<repo>/semanticFileIndex.json，
// 服务期 load 进内存即可；未构建/未就绪时全链路自动退化为纯词法，零副作用。
// ============================================================
import fs from 'fs';
import path from 'path';
import type { FastifyBaseLogger } from 'fastify';
import { DATA_DIR, currentRepoPath, currentRepoName, fileNodeMap } from '../../context.js';
import { canUseEmbedding, embedTexts, embedText, getEmbeddingModel } from '../embeddingService.js';

/** 查询期（问答内联路径）embedding 的独立短超时：超时立即退词法，不许拖问答。 */
const QUERY_EMBED_TIMEOUT_MS = Number(process.env.SEMANTIC_QUERY_TIMEOUT_MS || '') || 2500;

interface SemanticFile {
  filePath: string;
  vec: number[];
}
interface SemanticFileIndex {
  repoName: string;
  model: string;
  dims: number;
  files: SemanticFile[];
}

let semanticIndex: SemanticFileIndex | null = null;

export function hasSemanticIndex(): boolean {
  return !!semanticIndex && semanticIndex.files.length > 0;
}
export function setSemanticIndex(value: SemanticFileIndex | null): void {
  semanticIndex = value;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function isIndexableFile(f: string): boolean {
  return /\.(vue|tsx?|jsx?|js)$/i.test(f);
}

const CJK = /[一-龥]/;

/**
 * 为一个文件构造用于 embedding 的 profile 文本。
 * 组成：humanized 路径（英文语义）+ 文件里的中文片段（跨语言桥，关键）+ 节点名。
 * 有界（≤1000 字符），避免超模型上下文。读不到源码时退化为「路径+节点名」。
 */
function buildFileProfile(filePath: string): string {
  const humanized = filePath
    .replace(/\.[a-z]+$/i, '')
    .replace(/[/_.-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const nodeNames = (fileNodeMap.get(filePath) ?? []).slice(0, 24).map((n) => n.name).filter(Boolean).join(' ');

  let chinese = '';
  if (currentRepoPath) {
    try {
      const content = fs.readFileSync(path.join(currentRepoPath, filePath), 'utf-8').slice(0, 120_000);
      const seen = new Set<string>();
      const snips: string[] = [];
      outer: for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!CJK.test(line)) continue;
        for (const m of line.match(/[一-龥][一-龥A-Za-z0-9：:，。、（）()]{0,24}/g) ?? []) {
          const s = m.trim();
          if (s.length < 2 || seen.has(s)) continue;
          seen.add(s);
          snips.push(s);
          if (snips.length >= 60) break outer;
        }
      }
      chinese = snips.join(' ').slice(0, 700);
    } catch {
      // 读不到 → 只用路径 + 节点名
    }
  }

  return `${humanized}\n${chinese}\n${nodeNames}`.slice(0, 1000);
}

/**
 * 构建语义文件索引并持久化。embedding 未就绪时返回 null（调用方退回纯词法）。
 * 文件优先级：src/views|api|router|components（可查询业务面）排前，便于在 SEMANTIC_MAX_FILES 截断下仍覆盖到页面。
 */
/** 构建互斥：同 repo 已有构建在跑则跳过——防止 loadGraph 自建与 executeIndexBuild 强刷双触发（双倍 embedding 成本）。 */
let buildingRepo: string | null = null;

export async function buildSemanticFileIndex(repoName: string, log?: FastifyBaseLogger): Promise<{ built: number } | null> {
  if (!canUseEmbedding()) {
    log?.warn('[semantic] embedding 未就绪（缺 key/model/baseUrl），跳过语义索引');
    return null;
  }
  if (buildingRepo === repoName) {
    log?.info(`[semantic] ${repoName} 已有构建进行中，跳过重复触发`);
    return null;
  }
  buildingRepo = repoName;
  try {
    return await buildSemanticFileIndexInner(repoName, log);
  } finally {
    buildingRepo = null;
  }
}

async function buildSemanticFileIndexInner(repoName: string, log?: FastifyBaseLogger): Promise<{ built: number } | null> {
  const cap = Number(process.env.SEMANTIC_MAX_FILES || '') || 6000;
  const priority = (f: string): number => (/(^|\/)src\/(views|api|router|components)\//.test(f) ? 0 : 1);
  const files = [...fileNodeMap.keys()]
    .filter(isIndexableFile)
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, cap);
  if (files.length === 0) return null;

  const profiles = files.map(buildFileProfile);
  const BATCH = 48;
  const vecs: number[][] = [];
  for (let i = 0; i < profiles.length; i += BATCH) {
    const v = await embedTexts(profiles.slice(i, i + BATCH));
    if (!v) {
      log?.warn('[semantic] embedTexts 失败，放弃构建');
      return null;
    }
    for (const x of v) vecs.push(x);
    log?.info(`[semantic] embedded ${Math.min(i + BATCH, profiles.length)}/${profiles.length}`);
  }

  const idx: SemanticFileIndex = {
    repoName,
    model: getEmbeddingModel(),
    dims: vecs[0]?.length ?? 0,
    files: files.map((filePath, i) => ({ filePath, vec: vecs[i] })),
  };
  try {
    fs.writeFileSync(path.join(DATA_DIR, repoName, 'semanticFileIndex.json'), JSON.stringify(idx));
  } catch (e) {
    log?.warn(`[semantic] 持久化失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 完成守卫：构建是后台异步的，期间用户可能已切换项目——只有当前项目仍是本 repo 时
  // 才写内存索引，否则会用 A 项目的向量污染 B 项目的召回（磁盘文件按 repo 目录隔离，照常写）。
  if (currentRepoName === repoName) {
    setSemanticIndex(idx);
  } else {
    log?.warn(`[semantic] 构建完成时项目已切换（当前=${currentRepoName}），跳过内存索引写入`);
  }
  return { built: files.length };
}

/**
 * 从磁盘载入已构建的语义索引到内存。存在、非空、且与当前 embedding 配置兼容才返回 true。
 * 模型校验是硬性的：索引向量和查询向量必须出自同一个模型——换了 EMBEDDING_PROVIDER/MODEL
 * 后加载旧索引，余弦相似度是纯噪声且不报错（最难发现的一类静默劣化），宁可退词法。
 */
export function loadSemanticFileIndex(repoName: string, log?: FastifyBaseLogger): boolean {
  try {
    const p = path.join(DATA_DIR, repoName, 'semanticFileIndex.json');
    if (!fs.existsSync(p)) return false;
    const idx = JSON.parse(fs.readFileSync(p, 'utf-8')) as SemanticFileIndex;
    const currentModel = getEmbeddingModel();
    if (!idx.files?.length || !idx.dims || idx.dims <= 0) return false;
    if (idx.model !== currentModel) {
      log?.warn(`[semantic] 索引模型不匹配（索引=${idx.model}，当前=${currentModel}），拒绝加载并退词法；请重建语义索引`);
      setSemanticIndex(null);
      return false;
    }
    setSemanticIndex(idx);
    return hasSemanticIndex();
  } catch {
    return false;
  }
}

/**
 * 语义文件候选：embed 问题，与索引里所有文件向量算余弦，返回 top-N。
 * 未构建索引或 embed 失败 → 返回 []（调用方即纯词法）。
 */
export async function semanticFileCandidates(question: string, topN = 10): Promise<Array<{ filePath: string; score: number }>> {
  if (!hasSemanticIndex()) return [];
  // 查询期短超时：embedding 后端挂起时 2.5s 即放弃，退纯词法（构建期才允许 30s 级超时）
  const qv = await embedText(question, { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
  if (!qv) return [];
  return semanticIndex!.files
    .map((f) => ({ filePath: f.filePath, score: cosine(qv, f.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
