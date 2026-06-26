import { callChatCompletion, canUseLlm } from './llmService.js';
import { recordMemories, retrieveMemories } from '../db/memoryStore.js';
import type { Memory } from '@aiops/shared-types';

// ============================================================
// 记忆模块的 LLM 侧服务：检索拼装（注入）+ 每轮事实抽取（沉淀）
// 数据存取在 db/memoryStore.ts；这里只管"用 LLM 生成"和"拼成注入块"。
// ============================================================

/** 把检索到的记忆拼成可注入 LLM 的上下文块；无则返回空串。 */
export function buildMemoryBlock(memories: Memory[]): string {
  if (!memories.length) return '';
  const lines = memories.map((m) => `- ${m.content}`).join('\n');
  return `以下是与本项目相关的既往记忆（来自历史问答的沉淀，可能有助于理解背景；请甄别使用，不要凭空照搬）：\n${lines}`;
}

/** 取当前项目与问题最相关的记忆并拼成注入块（检索+拼装一步到位，失败返回空串不阻断）。 */
export function retrieveMemoryBlock(projectId: string, question: string, limit = 5): string {
  try {
    return buildMemoryBlock(retrieveMemories(projectId, question, limit));
  } catch {
    return '';
  }
}

/**
 * 每轮问答后台沉淀记忆：用 LLM 从 (问题, 回答) 抽取 ≤3 条值得长期记住的事实。
 * 调用方以 fire-and-forget 方式 `void` 调用；本函数自带 try/catch，绝不抛出影响主流程。
 */
export async function generateMemoriesFromTurn(
  projectId: string,
  conversationId: string | null,
  question: string,
  answer: string,
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
    ]);
    if (!out) return;

    // 丢弃否定/不确定类"伪事实"（如"…无法确认""未提及…"）——没长期价值，还会污染检索注入
    const isUseless = (l: string) =>
      /无法(确认|判断|确定|看出|得知|从)|未能确认|不确定|不清楚|未提及|没有(提及|体现|说明)|未(体现|说明)/.test(l);
    const items = out
      .split('\n')
      .map((l) => l.replace(/^[\s\-*•\d.、)]+/, '').trim())
      .filter((l) => l && l !== '无' && l.length >= 8 && !isUseless(l))
      .slice(0, 3)
      .map((content) => ({ kind: 'fact' as const, content }));

    if (items.length) recordMemories(projectId, conversationId, items);
  } catch {
    // best-effort：记忆沉淀失败不影响问答主流程
  }
}
