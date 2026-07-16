/**
 * 会话历史压缩（P2-H）—— 用「最近轮原文 + 早期历史 LLM 摘要」替代 v1 的硬截断。
 *
 * 动机：v1 的 buildLlmHistory 超预算直接丢最旧消息——20+ 轮会话里，用户在第 3 轮
 * 确立的关键上下文（"我说的下单页是 B 端那个"）会被无声丢掉，后续回答漂移。
 *
 * 机制（当轮零延迟）：
 *   - buildHistoryWindow：全部历史装得下 → 原样返回（短会话与 v1 完全一致，零回归）；
 *     装不下 → 「摘要（system 消息顶上）+ 未覆盖消息从新到旧装填」。
 *   - 窗口发现有消息既没进摘要也没进窗口（真实丢失）→ 后台 fire-and-forget 触发
 *     compactHistory 把「除最近 KEEP_RECENT 条外」的历史并入摘要——本轮仍按现状回答，
 *     下一轮摘要生效。与 generateMemoriesFromTurn 同款后台模式。
 *
 * 边界（改动前请读）：
 *   - LLM 不可用 / 摘要失败：静默保持 v1 截断行为，绝不阻断问答（增强不是闸门）。
 *   - 摘要覆盖水位用「过滤后消息条数」（见 conversationStore.getHistoryEntries 注释），
 *     消息 append-only 所以前缀稳定；绝不能改成时间戳水位。
 *   - 并发防抖：同会话同时只允许一个压缩任务（inFlight 集合）；压缩期间窗口继续用旧摘要。
 *   - 摘要是有损压缩：文件:行号 等硬事实要求 LLM 保留，但不做校验——历史窗口本就是
 *     "背景参考"，硬事实以当轮检索为准。
 */

import {
  getHistoryEntries,
  getConversationSummary,
  setConversationSummary,
  type HistoryEntry,
} from '../../db/conversationStore.js';
import { callChatCompletion, canUseLlm } from '../llmService.js';
import { estimateTokens, tokenizeForRecall } from './textUtils.js';
import { parsePositiveInt } from './contextBudget.js';

type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** 摘要消息的前缀标记（窗口里以 system 消息注入，observability 也靠它识别） */
export const SUMMARY_PREFIX = '【早期对话摘要】';

/** 保留原文的最近消息条数（≈3 轮问答），HISTORY_KEEP_RECENT 可调 */
function getKeepRecent(): number {
  return parsePositiveInt(process.env.HISTORY_KEEP_RECENT, 6);
}

/**
 * 摘要 token 上限（含前缀）。必须显著小于 history 预算（默认 1500 的 ~27%），否则摘要
 * 挤占甚至顶掉原文窗口。注意按 token 而非字符钳制：CJK 为主的摘要 1 字 ≈ 1.5 token，
 * 按字符卡会低估近 5 倍。
 */
const SUMMARY_MAX_TOKENS = 400;

/**
 * 溢出路径上单条消息的 token 上限。没有它，最新一轮的长答案（动辄 700+ token）会在
 * 装填时第一个撞预算、直接 break，把它前面的小消息（用户问题）全部堵死——窗口只剩摘要。
 * 截断保头部：本项目答案以「结论：…」开头，头部信息密度最高。
 */
const ENTRY_WINDOW_CAP_TOKENS = 250;

/** 按 token 钳制文本（10% 步进收缩、几轮内收敛）；不超限时原样返回。 */
function clampToTokens(text: string, maxTokens: number, suffix: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let s = text;
  while (s.length > 0 && estimateTokens(s) > maxTokens) {
    s = s.slice(0, Math.floor(s.length * 0.9));
  }
  return s + suffix;
}
/** 进摘要 prompt 时单条消息的截断长度（防长代码块把压缩调用本身撑爆） */
const ENTRY_CLAMP_CHARS = 800;

/**
 * 纯函数窗口装配（可测）：给定过滤后历史、缓存摘要与 token 预算，产出 prompt 消息列表。
 * needsCompaction = 有消息既不在摘要覆盖内、也没装进窗口（正在被无声丢弃）。
 */
export function assembleHistoryWindow(
  entries: HistoryEntry[],
  summary: { summary: string; covered: number } | null,
  tokenBudget: number,
): { messages: PromptMessage[]; needsCompaction: boolean } {
  // 从最新往旧装填，返回 [窗口消息（时间正序）, 被丢条数]。
  // clampCap：溢出路径用——单条超长消息截断后再装，而非撞预算即 break 堵死整个窗口
  const fill = (list: HistoryEntry[], budget: number, clampCap?: number): [PromptMessage[], number] => {
    const picked: PromptMessage[] = [];
    let total = 0;
    let i = list.length - 1;
    for (; i >= 0; i--) {
      const content = clampCap
        ? clampToTokens(list[i].content, clampCap, '…（此轮全文过长已截断）')
        : list[i].content;
      const cost = estimateTokens(content);
      if (total + cost > budget) break;
      total += cost;
      picked.push({ role: list[i].role, content });
    }
    picked.reverse();
    return [picked, i + 1];
  };

  // 1) 全部装得下 → 与 v1 行为完全一致（短会话零变化：不截断、摘要即使存在也不注入——原文保真度更高）
  const [full, droppedAll] = fill(entries, tokenBudget);
  if (droppedAll === 0) return { messages: full, needsCompaction: false };

  // 2) 装不下且无摘要 → 截断式装填（超长轮钳制）+ 请求后台压缩
  if (!summary) {
    const [clamped, dropped] = fill(entries, tokenBudget, ENTRY_WINDOW_CAP_TOKENS);
    return { messages: clamped, needsCompaction: dropped > 0 };
  }

  // 3) 摘要顶上：预算先扣掉摘要成本，剩余给「未覆盖」消息从新到旧装填（超长轮钳制）
  const summaryMsg: PromptMessage = { role: 'system', content: `${SUMMARY_PREFIX}${summary.summary}` };
  const summaryCost = estimateTokens(summaryMsg.content);
  if (summaryCost >= tokenBudget) {
    // 摘要比预算还大（预算被调得极小）：退回截断式装填，别让摘要独占窗口
    const [clamped, dropped] = fill(entries, tokenBudget, ENTRY_WINDOW_CAP_TOKENS);
    return { messages: clamped, needsCompaction: dropped > 0 };
  }
  const uncovered = entries.slice(Math.min(summary.covered, entries.length));
  const [verbatim, droppedUncovered] = fill(uncovered, tokenBudget - summaryCost, ENTRY_WINDOW_CAP_TOKENS);
  return {
    messages: [summaryMsg, ...verbatim],
    needsCompaction: droppedUncovered > 0,
  };
}

/** 同会话压缩任务去重（fire-and-forget 下的并发防抖） */
const inFlight = new Set<string>();

/**
 * 把「除最近 KEEP_RECENT 条外」的未覆盖历史并入摘要（合并旧摘要，覆盖式写回）。
 * @param summarize 摘要 LLM 调用，可注入 fake 做确定性测试；默认 callChatCompletion
 * @returns 是否真的写入了新摘要
 */
export async function compactHistory(
  conversationId: string,
  summarize: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ) => Promise<string | null> = callChatCompletion,
): Promise<boolean> {
  if (inFlight.has(conversationId)) return false;
  inFlight.add(conversationId);
  try {
    const entries = getHistoryEntries(conversationId);
    const prev = getConversationSummary(conversationId);
    const coveredNow = prev?.covered ?? 0;
    const targetCovered = Math.max(coveredNow, entries.length - getKeepRecent());
    if (targetCovered <= coveredNow) return false; // 目标覆盖已达成，无事可做

    const toCover = entries.slice(coveredNow, targetCovered);
    const transcript = toCover
      .map((e) => {
        const clamped =
          e.content.length > ENTRY_CLAMP_CHARS ? `${e.content.slice(0, ENTRY_CLAMP_CHARS)}…（截断）` : e.content;
        return `${e.role === 'user' ? '用户' : '助手'}：${clamped}`;
      })
      .join('\n');

    const merged = await summarize([
      {
        role: 'system',
        content: [
          '你是对话历史压缩器。把给定的代码问答对话浓缩成要点摘要，供后续对话轮次作为背景参考。',
          '- 保留：用户问过的问题主题、已给出的关键结论、提到的 文件:行号 / 接口路径 / 组件名、尚未解决的问题',
          '- 丢弃：寒暄、重复表述、大段代码',
          '- 用第三人称陈述句（如"用户询问了订单页的分页逻辑，助手定位到 OrderList.vue:120"）',
          '- 直接输出摘要正文，不要任何前后缀说明，控制在 300 字以内',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `${prev ? `已有早期摘要（需并入）：\n${prev.summary}\n\n` : ''}需要并入摘要的对话：\n${transcript}`,
      },
    ]);
    if (!merged || !merged.trim()) return false;

    // 按 token 钳制（LLM 可能突破"300 字以内"的指令），10% 步进收缩、几轮内收敛
    let body = merged.trim();
    while (body.length > 0 && estimateTokens(SUMMARY_PREFIX + body) > SUMMARY_MAX_TOKENS) {
      body = body.slice(0, Math.floor(body.length * 0.9));
    }
    if (!body) return false;
    setConversationSummary(conversationId, body, targetCovered);
    return true;
  } finally {
    inFlight.delete(conversationId);
  }
}

/**
 * 指代型追问的匹配模式：问题里出现这些词，通常意味着它单独拿去检索会丢失指称对象
 * （"这个核价列表页在哪"——检索只看见"核价列表页"，在多个同名域间乱撞）。
 */
const ANAPHORA_PATTERN =
  /这个|那个|这些|那些|它们?|该(页面|列表|组件|函数|接口|按钮|文件|字段|方法)|刚才|上一?轮|之前(问|提到|说)|最开始/;

/**
 * 指代补全（P2-H 活体验证暴露的缺口）：历史只进答案层、不进召回层——
 * 指代型追问的检索 query 缺失指称对象，codeContext 被无关页面占据后，
 * 答案层"以代码为准"的纪律反而放大错误（历史里的正确答案拗不过错误证据）。
 * 处理：检测到指代词且窗口里有用户轮 → 把最近至多 2 条用户问题拼在前面做检索语境。
 * 无历史 / 无指代时原样返回——单轮问答（含全部评测门禁）行为零变化。
 */
/** 两段文本是否有内容词元重叠（复用召回分词：中文 2~4 元 n-gram + 英数 token）。 */
function hasTokenOverlap(a: string, b: string): boolean {
  const tokensA = new Set(tokenizeForRecall(a));
  return tokenizeForRecall(b).some((t) => tokensA.has(t));
}

export function contextualizeQuestion(
  question: string,
  history: Array<{ role: string; content: string }>,
): string {
  if (history.length === 0 || !ANAPHORA_PATTERN.test(question)) return question;
  const candidates: string[] = [];
  // 摘要头部也进候选：长会话里指称对象（页面/文件名）往往已被折进摘要，
  // 摘要保留的 文件:行号 / 组件名 恰是最好的检索词
  const summaryMsg = history.find((m) => m.role === 'system' && m.content.startsWith(SUMMARY_PREFIX));
  if (summaryMsg) candidates.push(summaryMsg.content.slice(SUMMARY_PREFIX.length, SUMMARY_PREFIX.length + 160));
  const userTurns = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content.slice(0, 80));
  candidates.push(...userTurns);
  // 只保留与当前问题有词元重叠的候选——把所有近期轮无差别拼进去会引入竞争锚点，
  // 无关轮的页面名反而把检索带偏（评测 a-mt-earliest-turn 的教训）
  let parts = candidates.filter((c) => hasTokenOverlap(question, c));
  // 纯指代问题（"这个页面用了哪些接口"）自身无内容词、过滤后为空：兜底取最近一条用户轮
  if (parts.length === 0 && userTurns.length > 0) parts = [userTurns[userTurns.length - 1]];
  if (parts.length === 0) return question;
  return `${parts.join(' ')} ${question}`;
}

/**
 * ask / agent 两条路由的历史窗口统一入口（替代直接调 buildLlmHistory）。
 * 同步返回本轮窗口；发现历史正被无声丢弃时后台触发压缩（当轮零延迟，下一轮生效）。
 */
export function buildHistoryWindow(
  conversationId: string,
  tokenBudget: number,
  onError?: (err: unknown) => void,
): PromptMessage[] {
  const entries = getHistoryEntries(conversationId);
  const summary = getConversationSummary(conversationId);
  const { messages, needsCompaction } = assembleHistoryWindow(entries, summary, tokenBudget);
  if (needsCompaction && canUseLlm()) {
    void compactHistory(conversationId).catch((err) => onError?.(err));
  }
  return messages;
}
