import type { LlmUsageContext } from './usage/usageTracker.js';
import { callChatCompletion, canUseLlm } from './llmService.js';
import { canUseEmbedding, embedTexts, embedText, getEmbeddingModel } from './embeddingService.js';
import {
  recordMemories,
  retrieveMemoriesHybrid,
  countEmbeddedMemories,
  getEmbeddedMemories,
  listMemoriesNeedingEmbedding,
  setMemoryEmbedding,
  type MemoryDraft,
} from '../db/memoryStore.js';
import type { Memory } from '@aiops/shared-types';

// ============================================================
// 记忆模块的 LLM/embedding 侧服务：检索拼装（注入）+ 每轮事实抽取（沉淀）+ 向量回填。
// 数据存取在 db/memoryStore.ts（同步纯 CRUD）；这里管所有「要发网络的」编排。
// 记忆 v2：写入时向量化 + 语义近重复去噪；检索时 query 向量化 + 关键词/语义 RRF 混合。
// 全程 embedding 不可用即 dormant，退回 v1 纯关键词，零回归。
// ============================================================

/** query 向量化的短超时：慢了就退关键词，不拖问答（与语义/文档召回同款取舍）。 */
const QUERY_EMBED_TIMEOUT_MS = Number(process.env.SEMANTIC_QUERY_TIMEOUT_MS || '') || 2500;
/** 写入时语义近重复阈值：与已有记忆余弦 ≥ 此值即视为「换个说法的同一件事」，跳过。 */
const SEMANTIC_DUP_THRESHOLD = Number(process.env.MEMORY_DUP_COSINE || '') || 0.92;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** 把检索到的记忆拼成可注入 LLM 的上下文块；无则返回空串。 */
export function buildMemoryBlock(memories: Memory[]): string {
  if (!memories.length) return '';
  const lines = memories.map((m) => `- ${m.content}`).join('\n');
  return `以下是与本项目相关的既往记忆（来自历史问答的沉淀，可能有助于理解背景；请甄别使用，不要凭空照搬）：\n${lines}`;
}

/**
 * 取当前项目与问题最相关的记忆并拼成注入块（检索+拼装一步到位，失败返回空串不阻断）。
 * 记忆 v2：仅当「embedding 可用 且 本项目已有向量化记忆」时才为 query 付一次 embedding，
 * 融合语义召回；否则纯关键词（零额外延迟）。
 */
export async function retrieveMemoryBlock(projectId: string, question: string, limit = 5): Promise<string> {
  try {
    const model = getEmbeddingModel();
    let queryEmbedding: number[] | null = null;
    // 闸门：没配 embedding 或本项目还没有任何向量化记忆 → 不白调网络，直接走关键词
    if (canUseEmbedding() && countEmbeddedMemories(projectId, model) > 0) {
      queryEmbedding = await embedText(question, { timeoutMs: QUERY_EMBED_TIMEOUT_MS });
    }
    const memories = retrieveMemoriesHybrid(projectId, question, queryEmbedding, queryEmbedding ? model : null, limit);
    return buildMemoryBlock(memories);
  } catch {
    return '';
  }
}

/**
 * 每轮问答后台沉淀记忆：用 LLM 从 (问题, 回答) 抽取 ≤3 条值得长期记住的事实，向量化后入库。
 * 调用方以 fire-and-forget 方式 `void` 调用；本函数自带 try/catch，绝不抛出影响主流程。
 */
export async function generateMemoriesFromTurn(
  projectId: string,
  conversationId: string | null,
  question: string,
  answer: string,
  /** 成本追踪上下文（阶段 3）：抽取是本轮触发的后台调用，成本归到触发它的那一轮 */
  usage?: LlmUsageContext,
): Promise<void> {
  try {
    if (!canUseLlm()) return;
    const a = (answer ?? '').trim();
    // 信号闸：太短的、或"没找到/无法回答"类的答案，提不出有价值的长期事实，直接跳过
    if (a.length < 200) return;
    if (/未找到|没有找到|无法回答|抱歉|证据不足|未能|没有足够/.test(a.slice(0, 120))) return;

    const sys = '你是"记忆提取器"。只输出要点，不解释、不寒暄。';
    const user = `从下面这轮"代码库问答"中，提取最多 3 条值得长期记住的事实——优先记录关于这个代码库的稳定结论（某功能在哪个模块、某模块的职责、关键约定/技术选型）或用户的关注点/偏好。要求：每条一行、以"- "开头、一句话、不含行号等易失效细节；**只记你能确定的肯定结论；遇到"无法确认/未提及/不清楚"这类否定或不确定的内容一律不要记**；若没有值得长期记住的，只输出"无"。

问题：${question}

回答：${answer.slice(0, 2000)}`;

    const out = await callChatCompletion([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], undefined, usage);
    if (!out) return;

    const isUseless = (l: string) =>
      /无法(确认|判断|确定|看出|得知|从)|未能确认|不确定|不清楚|未提及|没有(提及|体现|说明)|未(体现|说明)/.test(l);
    const contents = out
      .split('\n')
      .map((l) => l.replace(/^[\s\-*•\d.、)]+/, '').trim())
      .filter((l) => l && l !== '无' && l.length >= 8 && !isUseless(l))
      .slice(0, 3);
    if (contents.length === 0) return;

    // 向量化 + 语义近重复去噪（记忆 v2）。embedding 不可用时 drafts 无向量，退回纯文本去重。
    let drafts: MemoryDraft[] = contents.map((content) => ({ kind: 'fact' as const, content }));
    if (canUseEmbedding()) {
      const model = getEmbeddingModel();
      const vectors = await embedTexts(contents);
      if (vectors && vectors.length === contents.length) {
        const existing = getEmbeddedMemories(projectId, model);
        const accepted: MemoryDraft[] = [];
        for (let i = 0; i < contents.length; i++) {
          const vec = vectors[i];
          // 与已有记忆、以及本批已接受项都比对，任一余弦 ≥ 阈值即判语义重复
          const dupExisting = existing.some((m) => cosine(vec, m.embedding) >= SEMANTIC_DUP_THRESHOLD);
          const dupBatch = accepted.some((d) => d.embedding && cosine(vec, d.embedding) >= SEMANTIC_DUP_THRESHOLD);
          if (dupExisting || dupBatch) continue;
          accepted.push({ kind: 'fact', content: contents[i], embedding: vec, embedModel: model });
        }
        drafts = accepted;
      }
    }
    if (drafts.length === 0) return;
    recordMemories(projectId, conversationId, drafts);

    // 顺带回填该项目里历史遗留的未向量化记忆（v1 老数据 / 之前 embedding 不可用时写入的）。
    void backfillMemoryEmbeddings(projectId);
  } catch {
    // best-effort：记忆沉淀失败不影响问答主流程
  }
}

/**
 * 后台回填：给该项目「未向量化 / 模型不匹配」的记忆补上当前模型的向量。
 * 有界（一次最多 50 条）+ 静默失败，避免拖慢或刷屏。embedding 不可用时直接返回。
 */
export async function backfillMemoryEmbeddings(projectId: string): Promise<void> {
  try {
    if (!canUseEmbedding()) return;
    const model = getEmbeddingModel();
    const pending = listMemoriesNeedingEmbedding(projectId, model, 50);
    if (pending.length === 0) return;
    const vectors = await embedTexts(pending.map((p) => p.content));
    if (!vectors || vectors.length !== pending.length) return;
    for (let i = 0; i < pending.length; i++) {
      setMemoryEmbedding(pending[i].id, vectors[i], model);
    }
  } catch {
    // 回填失败不致命，下轮再来
  }
}
