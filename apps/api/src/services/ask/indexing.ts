// ============================================================
// 索引构建（页面锚点 / 召回 / 事实）
// 从 askService.ts 拆分而来（行为保持不变）
// ============================================================

import fs from 'fs';
import path from 'path';
import type { FastifyBaseLogger } from 'fastify';
import type {
  GraphNode,
} from '@aiops/shared-types';
import {
  MONOREPO_ROOT,
  DOCS_PATH,
  currentRepoPath,
  fileNodeMap,
  pageAnchors,
  setRecallIndex,
  setFileRecallIndex,
  setFactIndex,
  setDocIndex,
  setPageAnchors,
  type RecallDoc,
  type FileRecallDoc,
  type FactKind,
  type CodeFact,
  type DocChunk,
  type PageAnchor,
} from '../../context.js';
import { tokenizeForRecall } from './textUtils.js';
import { hasApiSignal, listFilesRecursively } from './codeScan.js';
import { extractPagePhrase } from './questionAnalysis.js';
import { embedTexts, canUseEmbedding, getEmbeddingModel } from '../embeddingService.js';


function normalizeComponentAlias(aliasPath: string): string {
  let rel = aliasPath.trim();
  if (rel.startsWith('@/')) {
    rel = `src/${rel.slice(2)}`;
  }
  if (!/\.(vue|tsx?|jsx?)$/i.test(rel)) {
    rel = `${rel}.vue`;
  }
  return rel;
}


function tokenizePageText(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}


function normalizeScopeText(input: string): string {
  return input
    .replace(/[？?，。,.:：]/g, '')
    .replace(/(页面|模块|功能|逻辑|是什么|怎么|如何|用了哪些|用了那些|有哪些|调用了哪些|调用了什么|后端|接口|按钮|触发|条件|里|中)/g, '')
    .trim();
}


function charOverlapRatio(a: string, b: string): number {
  const setA = new Set(Array.from(a));
  const setB = new Set(Array.from(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const ch of setA) {
    if (setB.has(ch)) inter++;
  }
  return inter / Math.max(setA.size, setB.size);
}


export function buildPageAnchorIndex(log?: FastifyBaseLogger): void {
  setPageAnchors([]);
  if (!currentRepoPath) return;

  const routerDir = path.join(currentRepoPath, 'src/router/modules');
  if (!fs.existsSync(routerDir)) return;

  const files = fs.readdirSync(routerDir).filter((name) => name.endsWith('.ts'));
  const newAnchors: PageAnchor[] = [];
  for (const fileName of files) {
    const absPath = path.join(routerDir, fileName);
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const routeRegex = /\{[\s\S]*?component:\s*async[\s\S]*?import\(\s*['"`]([^'"`]+)['"`]\s*\)[\s\S]*?meta:\s*\{[\s\S]*?title:\s*['"`]([^'"`]+)['"`][\s\S]*?\}[\s\S]*?\}/g;
    let match: RegExpExecArray | null = null;
    while ((match = routeRegex.exec(content)) !== null) {
      const componentAlias = match[1]?.trim();
      const title = match[2]?.trim();
      if (!componentAlias || !title) continue;

      const block = match[0];
      const nameMatch = block.match(/name:\s*['"`]([^'"`]+)['"`]/);
      newAnchors.push({
        title,
        componentFile: normalizeComponentAlias(componentAlias),
        routeName: nameMatch?.[1]?.trim(),
      });
    }
  }

  const deduped = Array.from(
    new Map(newAnchors.map((anchor) => [`${anchor.title}|${anchor.componentFile}`, anchor])).values()
  );
  setPageAnchors(deduped);
  log?.info(`页面锚点已构建: ${deduped.length} routes`);
}


function scorePageAnchor(phrase: string, anchor: PageAnchor): number {
  const normalizedPhrase = normalizeScopeText(phrase) || phrase;
  const p = normalizedPhrase.toLowerCase();
  const t = anchor.title.toLowerCase();
  const c = anchor.componentFile.toLowerCase();
  const n = (anchor.routeName ?? '').toLowerCase();
  let score = 0;

  if (t.includes(p)) score += 10;
  if (p.includes(t)) score += 6;
  if (c.includes(p) || n.includes(p)) score += 8;

  const phraseTokens = tokenizePageText(phrase);
  const anchorTokens = new Set(tokenizePageText(`${anchor.title} ${anchor.componentFile} ${anchor.routeName ?? ''}`));
  for (const token of phraseTokens) {
    if (anchorTokens.has(token)) score += 2;
  }
  score += charOverlapRatio(normalizedPhrase, anchor.title) * 12;
  return score;
}


export function findBestPageAnchor(question: string): PageAnchor | null {
  const phrase = extractPagePhrase(question) ?? question;
  return findBestPageAnchorByText(phrase);
}


export function findBestPageAnchorByText(text: string): PageAnchor | null {
  if (!text || pageAnchors.length === 0) return null;

  let best: { anchor: PageAnchor; score: number } | null = null;
  for (const anchor of pageAnchors) {
    const score = scorePageAnchor(text, anchor);
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { anchor, score };
    }
  }

  return best?.anchor ?? null;
}


export function buildRecallIndex(nodes: GraphNode[], repoName: string, log?: FastifyBaseLogger): void {
  const docs: RecallDoc[] = [];
  const df = new Map<string, number>();

  for (const node of nodes) {
    if (node.type === 'file') continue;
    const text = [
      node.name,
      node.filePath,
      node.type,
      node.meta?.apiMethod ?? '',
      node.meta?.apiEndpoint ?? '',
      node.meta?.reactiveType ?? '',
    ].join(' ');
    const tokens = tokenizeForRecall(text).slice(0, 64);
    if (tokens.length === 0) continue;

    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }

    docs.push({ node, tf, norm: 1 });
  }

  const idf = new Map<string, number>();
  const docCount = docs.length || 1;
  for (const [token, freq] of df.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }

  for (const doc of docs) {
    let sum = 0;
    for (const [token, count] of doc.tf.entries()) {
      const weight = count * (idf.get(token) ?? 1);
      sum += weight * weight;
    }
    doc.norm = Math.sqrt(sum) || 1;
  }

  setRecallIndex({ repoName, idf, docs });
  log?.info(`向量召回索引已构建: ${repoName} (${docs.length} docs)`);
}


export function buildFileRecallIndex(repoName: string, log?: FastifyBaseLogger): void {
  if (!currentRepoPath || fileNodeMap.size === 0) {
    setFileRecallIndex(null);
    return;
  }

  const docs: FileRecallDoc[] = [];
  const df = new Map<string, number>();
  for (const filePath of fileNodeMap.keys()) {
    const absPath = path.join(currentRepoPath, filePath);
    if (!fs.existsSync(absPath)) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf-8').slice(0, 120_000);
      const tokens = tokenizeForRecall(content).slice(0, 1_200);
      if (tokens.length === 0) continue;

      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      for (const token of new Set(tokens)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
      docs.push({ filePath, tf, norm: 1 });
    } catch {
      // ignore unreadable files
    }
  }

  const idf = new Map<string, number>();
  const docCount = docs.length || 1;
  for (const [token, freq] of df.entries()) {
    idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
  }
  for (const doc of docs) {
    let sum = 0;
    for (const [token, count] of doc.tf.entries()) {
      const weight = count * (idf.get(token) ?? 1);
      sum += weight * weight;
    }
    doc.norm = Math.sqrt(sum) || 1;
  }

  setFileRecallIndex({ repoName, idf, docs });
  log?.info(`文件语义召回索引已构建: ${repoName} (${docs.length} files)`);
}


function extractActionLabelFromLine(line: string): string | null {
  const m = line.match(/\b(?:name|alias)\s*:\s*['"`]([^'"`]{1,40})['"`]/);
  const label = (m?.[1] ?? '').trim();
  return label || null;
}


function classifyFactKinds(line: string): FactKind[] {
  const text = line.trim();
  if (!text) return [];
  const kinds: FactKind[] = [];
  if (/(v-if|v-show|visible\s*:|disabled\s*:|disabled\s*=|permission|if\s*\(|\?.*:|&&|\|\||\breturn\b)/i.test(text)) {
    kinds.push('condition');
  }
  if (/(onClick=|@click=|handleClick|handle\w+\(|open\w+\(|confirm\w+\(|submit\w+\()/i.test(text)) {
    kinds.push('trigger');
  }
  if (/(this\.\w+\s*=|reactive\(|ref\(|computed\(|watch\(|data\s*\(\)|set\w+\()/i.test(text)) {
    kinds.push('state');
  }
  if (hasApiSignal(text)) {
    kinds.push('api');
  }
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*\(|^\s*const\s+[A-Za-z_$][\w$]*\s*=/.test(text)) {
    kinds.push('logic');
  }
  return kinds;
}


function extractFactsFromFile(filePath: string): CodeFact[] {
  if (!currentRepoPath) return [];
  const absPath = path.join(currentRepoPath, filePath);
  if (!fs.existsSync(absPath)) return [];

  const ext = path.extname(filePath).toLowerCase();
  if (!['.vue', '.ts', '.tsx', '.js', '.jsx'].includes(ext)) return [];

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }

  const facts: CodeFact[] = [];
  const pushFact = (line: number, kind: FactKind, text: string, context?: string): void => {
    const terms = tokenizeForRecall(`${context ?? ''} ${text}`).slice(0, 40);
    if (terms.length === 0) return;
    const id = `${filePath}:${line}:${kind}:${context ?? ''}:${text.slice(0, 48)}`;
    facts.push({ id, filePath, line, kind, text, terms, context });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const kinds = classifyFactKinds(line);
    for (const kind of kinds) {
      pushFact(i + 1, kind, line);
    }

    const actionLabel = extractActionLabelFromLine(line);
    if (!actionLabel) continue;
    const context = `action:${actionLabel}`;
    pushFact(i + 1, 'trigger', line, context);
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 10); j++) {
      if (j === i) continue;
      const near = (lines[j] ?? '').trim();
      if (!near) continue;
      if (!/(visible\s*:|disabled\s*:|disabled\s*=|handleClick\s*:|onClick=|@click=|params\s*:|v-if|v-show)/i.test(near)) continue;
      const nearKinds = classifyFactKinds(near);
      if (nearKinds.length === 0) continue;
      for (const kind of nearKinds) {
        pushFact(j + 1, kind, near, context);
      }
    }
  }

  return facts;
}


export function buildFactIndex(repoName: string, log?: FastifyBaseLogger): void {
  if (!currentRepoPath || fileNodeMap.size === 0) {
    setFactIndex(null);
    return;
  }

  const allFacts: CodeFact[] = [];
  for (const filePath of fileNodeMap.keys()) {
    allFacts.push(...extractFactsFromFile(filePath));
  }

  const dedup = Array.from(new Map(allFacts.map((fact) => [fact.id, fact])).values());
  setFactIndex({ repoName, facts: dedup });
  log?.info(`通用事实索引已构建: ${repoName} (${dedup.length} facts)`);
}


// ============================================================
// 文档证据通道：markdown 分块 + 文档索引构建
// chunkMarkdown 为纯函数（可单测）；buildDocIndex 负责读盘 + 向量化 + idf。
// ============================================================

/** 单块文档块上限（字符）；超过则按段落拆分。 */
const DOC_CHUNK_MAX_CHARS = 800;

/** 未向量化的文档块草稿（embedding / indexedAt 由 buildDocIndex 填充）。 */
export type DocChunkDraft = Omit<DocChunk, 'embedding' | 'indexedAt'>;

function packParagraphs(text: string, maxChars: number): string[] {
  const paras = text.split(/\n{2,}/);
  const packed: string[] = [];
  let buf = '';
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > maxChars) {
      packed.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf.trim()) packed.push(buf);

  // 单段本身超限时硬切，保证每块 <= maxChars
  return packed.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    const pieces: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChars) {
      pieces.push(chunk.slice(i, i + maxChars));
    }
    return pieces;
  });
}

/**
 * 把一篇 markdown 切成文档块草稿。
 * - title：首个 H1，缺失则回退到文件名（去扩展名）
 * - 按标题（#~######）分节；首个标题前的内容归为无 section 的前言块
 * - 超过 DOC_CHUNK_MAX_CHARS 的节按段落再拆
 */
export function chunkMarkdown(content: string, source: string): DocChunkDraft[] {
  const lines = content.split(/\r?\n/);
  const baseName = (source.split('/').pop() ?? source).replace(/\.(md|markdown)$/i, '');

  let title = baseName;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1) { title = h1[1].trim(); break; }
  }

  type RawSection = { section?: string; body: string[] };
  const headingRe = /^#{1,6}\s+(.+?)\s*$/;
  const sections: RawSection[] = [];
  let current: RawSection = { section: undefined, body: [] };
  for (const line of lines) {
    const h = line.match(headingRe);
    if (h) {
      if (current.body.some((l) => l.trim())) sections.push(current);
      current = { section: h[1].trim(), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.some((l) => l.trim())) sections.push(current);

  const drafts: DocChunkDraft[] = [];
  let idx = 0;
  for (const sec of sections) {
    const text = sec.body.join('\n').trim();
    if (!text) continue;
    const pieces = text.length <= DOC_CHUNK_MAX_CHARS ? [text] : packParagraphs(text, DOC_CHUNK_MAX_CHARS);
    for (const piece of pieces) {
      const t = piece.trim();
      if (!t) continue;
      const terms = tokenizeForRecall(`${title} ${sec.section ?? ''} ${t}`).slice(0, 200);
      drafts.push({ id: `${source}#${idx}`, title, section: sec.section, source, text: t, terms });
      idx++;
    }
  }
  return drafts;
}

/**
 * 构建文档证据索引。失败/未配置时清空 docIndex（问答退回纯代码模式，行为同现状）。
 * 自身不抛错，可安全 fire-and-forget。
 */
export async function buildDocIndex(repoName: string, log?: FastifyBaseLogger): Promise<void> {
  if (!DOCS_PATH) { setDocIndex(null); return; }
  if (!canUseEmbedding()) {
    setDocIndex(null);
    log?.warn('已配置 DOCS_PATH，但 embedding 未就绪（缺 key/model/baseUrl），跳过文档索引');
    return;
  }

  try {
    const docsDir = path.isAbsolute(DOCS_PATH) ? DOCS_PATH : path.resolve(MONOREPO_ROOT, DOCS_PATH);
    if (!fs.existsSync(docsDir)) {
      setDocIndex(null);
      log?.warn(`文档目录不存在: ${docsDir}，跳过文档索引`);
      return;
    }

    const mdFiles = listFilesRecursively(docsDir, 6).filter((f) => /\.(md|markdown)$/i.test(f));
    const drafts: DocChunkDraft[] = [];
    for (const absFile of mdFiles) {
      let content = '';
      try { content = fs.readFileSync(absFile, 'utf-8'); } catch { continue; }
      const rel = path.relative(docsDir, absFile).split(path.sep).join('/');
      drafts.push(...chunkMarkdown(content, rel));
    }
    if (drafts.length === 0) {
      setDocIndex(null);
      log?.info(`文档目录无可索引内容: ${docsDir}`);
      return;
    }

    const vectors = await embedTexts(drafts.map((d) => d.text));
    if (!vectors || vectors.length !== drafts.length) {
      setDocIndex(null);
      log?.warn('文档向量化失败，跳过文档索引（问答仍按纯代码模式运行）');
      return;
    }

    const indexedAt = new Date().toISOString();
    const chunks: DocChunk[] = drafts.map((d, i) => ({ ...d, embedding: vectors[i], indexedAt }));

    // 文档级 TF-IDF（词法那一路），与 buildRecallIndex 同款
    const df = new Map<string, number>();
    for (const chunk of chunks) {
      for (const token of new Set(chunk.terms)) df.set(token, (df.get(token) ?? 0) + 1);
    }
    const idf = new Map<string, number>();
    const docCount = chunks.length || 1;
    for (const [token, freq] of df.entries()) {
      idf.set(token, Math.log((docCount + 1) / (freq + 1)) + 1);
    }

    const dim = chunks[0]?.embedding.length ?? 0;
    setDocIndex({ repoName, model: getEmbeddingModel(), dim, idf, chunks });
    log?.info(`文档证据索引已构建: ${repoName} (${chunks.length} chunks, dim=${dim})`);
  } catch (err) {
    setDocIndex(null);
    log?.warn(`文档索引构建异常，跳过: ${err instanceof Error ? err.message : String(err)}`);
  }
}
