/**
 * 答案质量评审（LLM-as-judge）—— L3 评测核心，也供 L4 线上抽样打分复用。
 *
 * 从 test/eval/judge.ts 迁入 src（原因：观测层要在生产链路里抽样调用 judge，
 * 而 build 只打包 src/；test/eval/judge.ts 现在是本模块的 re-export 壳）。
 *
 * 分两层，先便宜后贵：
 *  - 确定性子检查（免费、稳定、可进 CI）：mustMention / mustNotHallucinate 纯字符串判定。
 *  - LLM-judge（贵、有噪声，只用在字符串判不了的维度）：
 *      faithful  忠实度——答案的技术论断是否被 evidence 支持（抓幻觉）
 *      correct   正确性——与 referenceAnswer 对照核心结论（未提供则 null）
 *      codeFirst 代码优先——代码与文档冲突时是否以代码为准（无 docSnippet 则 null）
 *
 * 降噪三件套：温度低（llmService 内固定 0.2）、同题多票取多数（分数取中位）、
 * 磁盘缓存（data/.aiops/evalJudgeCache.json，按 输入+PROMPT_VERSION 哈希，改 prompt 自动失效）。
 *
 * 已知局限（诚实声明）：judge 与被评答案共用同一个 LLM 配置——同源裁判会系统性偏宽，
 * 换更强的独立 judge 模型是升级方向；当前先把 harness 与 rubric 打稳。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Evidence } from '@aiops/shared-types';
import { DATA_DIR } from '../context.js';
import { callChatCompletion, callApiCompatibleChatCompletion, canUseLlm } from './llmService.js';

/**
 * 独立 judge 模型（可选）：解"同源裁判偏宽"——judge 与被评答案共用同一 LLM 时会系统性
 * 高估自己。配置 JUDGE_LLM_BASE_URL + JUDGE_LLM_MODEL（OpenAI 兼容端点，如本机
 * ollama http://localhost:11434/v1 + gpt-oss:20b）后，judge 走独立后端；未配置则回落主 LLM。
 */
const JUDGE_LLM_BASE_URL = (process.env.JUDGE_LLM_BASE_URL ?? '').trim().replace(/\/+$/, '');
const JUDGE_LLM_MODEL = process.env.JUDGE_LLM_MODEL?.trim() ?? '';
const judgeHasOwnLlm = Boolean(JUDGE_LLM_BASE_URL && JUDGE_LLM_MODEL);

function judgeLlmCall(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string | null> {
  if (judgeHasOwnLlm) return callApiCompatibleChatCompletion(messages, 'custom', JUDGE_LLM_MODEL, JUDGE_LLM_BASE_URL);
  return callChatCompletion(messages);
}

/** judge 是否可用：有独立后端，或主 LLM 可用。 */
function canJudge(): boolean {
  return judgeHasOwnLlm || canUseLlm();
}

// ============ 确定性子检查（纯函数，CI 可测） ============

/** answer 是否提到了每个必提词（大小写不敏感）。 */
export function checkMentions(answer: string, mustMention: string[]): { ok: boolean; missing: string[] } {
  const lower = answer.toLowerCase();
  const missing = mustMention.filter((m) => !lower.includes(m.toLowerCase()));
  return { ok: missing.length === 0, missing };
}

/** answer 是否踩了禁提词（出现即视为幻觉/张冠李戴）。 */
export function checkHallucinations(answer: string, mustNot: string[]): { ok: boolean; hits: string[] } {
  const lower = answer.toLowerCase();
  const hits = mustNot.filter((m) => lower.includes(m.toLowerCase()));
  return { ok: hits.length === 0, hits };
}

// ============ LLM-judge ============

export interface JudgeInput {
  question: string;
  answer: string;
  evidence: Evidence[];
  /** 有参考答案时 judge 才评 correct，否则 null。 */
  referenceAnswer?: string;
  /** 有文档片段（与代码证据矛盾）时 judge 才评 codeFirst，否则 null。 */
  docSnippet?: string;
  /**
   * 答案生成时看到的代码上下文（口径对齐，v4 起）：答案的信息源是完整 codeContext，
   * 只按 12 条 evidence 清单判忠实会把"真实但没进清单"的细节误判为编造。
   * 传入后 rubric 认它为合法依据；不传则维持旧口径（evidence-only，偏严）。
   */
  codeContext?: string;
  /**
   * 覆盖点清单（P1-C 长任务专属，v5）：任务要求答案讲清的链路环节
   *（如"页面入口""触发方法""接口调用""状态变化"）。judge 逐项判答案是否讲到，
   * 产出 coverage 命中率——长任务"完整度"的量化维度，短问答不传则 coverage=null。
   */
  coverageChecklist?: string[];
}

/** 覆盖度评估（P1-C）：命中的覆盖点 / 总数 + 未覆盖项，无 checklist 时整体为 null。 */
export interface CoverageVerdict {
  covered: number;
  total: number;
  missing: string[];
}

export interface JudgeVerdict {
  faithful: boolean;
  correct: boolean | null;
  codeFirst: boolean | null;
  /** 覆盖度（仅长任务、提供了 coverageChecklist 时非 null）。 */
  coverage: CoverageVerdict | null;
  /** 0-10 总评分。 */
  score: number;
  reasons: { faithful: string; correct?: string; codeFirst?: string; coverage?: string };
}

/**
 * 改 rubric/prompt 时递增，缓存自动失效。
 * v2：codeFirst 从布尔改为 basis 枚举——v1 实测 judge 会"理由说违反代码优先、结论却输出 true"
 *（布尔极性翻转）；让模型报「答案以什么为准」(code/doc/mixed/n/a) 这种事实性枚举，比让它
 * 直接给合规布尔稳得多，极性映射由解析层做。
 * v3：收紧 mixed 定义——v2 实测"提及文档并指出其过时"被误判 mixed，可指出文档过时恰是
 * 最好的代码优先行为；mixed 仅指「结论摇摆/未取舍」。
 * v4：口径对齐——faithful 的合法依据扩展到「相关代码上下文」（答案的真实信息源）。
 * v3 只认 evidence 清单，实测把"源码里真实存在但没挤进 12 条清单"的细节误判为编造
 *（L2 引用核对 100% 而 judge 判不忠实的矛盾即此）。行号型论断仍须严格对上。
 * v5：加 coverage 维度（P1-C 长任务完整度）——提供【覆盖点清单】时逐项判答案是否讲清，
 * 输出命中列表；未提供则 coverage 段整体缺省。仅追加维度，不改 faithful/correct/basis 判据。
 */
const PROMPT_VERSION = 'v6';

function buildJudgeMessages(input: JudgeInput): Array<{ role: 'system' | 'user'; content: string }> {
  const evidenceBlock = input.evidence
    .slice(0, 16)
    .map((e) => `- ${e.file}:${e.line} 「${e.code.slice(0, 120)}」`)
    .join('\n') || '（无）';

  const sections = [
    `【用户问题】\n${input.question}`,
    `【代码证据】（检索自真实仓库）\n${evidenceBlock}`,
  ];
  if (input.codeContext) {
    // 截断保护：codeContext 生成侧本身有预算（~6000 字符），这里再兜一道底
    sections.push(`【相关代码上下文】（答案生成时看到的完整代码材料，同为可信事实来源）\n${input.codeContext.slice(0, 6500)}`);
  }
  if (input.docSnippet) sections.push(`【相关文档片段】（可能过时，与代码冲突时以代码为准）\n${input.docSnippet}`);
  if (input.referenceAnswer) sections.push(`【参考答案】（人工标注的核心结论）\n${input.referenceAnswer}`);
  const hasCoverage = Array.isArray(input.coverageChecklist) && input.coverageChecklist.length > 0;
  if (hasCoverage) {
    sections.push(`【覆盖点清单】（答案应逐一讲清的链路环节）\n${input.coverageChecklist!.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  }
  sections.push(`【待评审答案】\n${input.answer.slice(0, 3000)}`);

  return [
    {
      role: 'system',
      content: [
        '你是严格的代码问答质量评审。只依据给出的材料评审，不使用外部知识。逐项判定：',
        '1. faithful（忠实度）：答案中的每个具体技术论断（文件名/函数名/行号/条件/流程）是否都能在【代码证据】或【相关代码上下文】（若提供）中找到支持？两处都找不到的具体断言即为 false；引用的 文件:行号 必须与材料中标注的行号严格对应。',
        '2. correct（正确性）：仅当提供了【参考答案】时判定——答案的核心结论与参考答案是否一致？未提供则输出 null。',
        '3. basis（答案的结论以什么为准）：仅当提供了【相关文档片段】时判定，看的是「结论」而非「是否提及」：',
        '   "code"=结论以代码证据为准（答案提及文档、甚至指出文档过时，只要结论站在代码一边，就是 code）；',
        '   "doc"=结论采信了文档的说法；"mixed"=结论在两者间摇摆、未明确取舍；未提供文档片段时输出 "n/a"。',
        hasCoverage
          ? '4. coveredPoints（覆盖度）：仅当提供了【覆盖点清单】时判定。【重要】这一项只评估答案正文本身的完整度，与 faithful/证据无关——逐一检查每个覆盖点，答案是否用具体的文件/方法/条件/结论把该环节讲清了（不是仅提及名词）；即使【代码证据】为空，也照常只按答案正文逐项判定，讲清了就计入（证据背书由 faithful 负责、绝不影响本项）。输出实质讲清了的覆盖点【序号】数组（从 1 计）。'
          : '4. coveredPoints：未提供覆盖点清单，输出空数组 []。',
        '5. score：0-10 总评（考虑以上各项与表达清晰度）。',
        '只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块：',
        '{"faithful":bool,"correct":bool|null,"basis":"code"|"doc"|"mixed"|"n/a","coveredPoints":number[],"score":number,"reasons":{"faithful":"一句话","correct":"一句话或省略","basis":"一句话或省略","coverage":"一句话或省略"}}',
      ].join('\n'),
    },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

/**
 * 从 LLM 输出里稳健抠出 JSON（容忍 ```json 围栏/前后杂文）。解析失败返回 null。
 * coverageChecklist 传入时，把模型返回的 coveredPoints 序号映射为 coverage 命中/未覆盖。
 */
export function parseJudgeJson(text: string, coverageChecklist?: string[]): JudgeVerdict | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as Partial<JudgeVerdict> & {
      basis?: string;
      coveredPoints?: unknown;
      reasons?: Record<string, string>;
    };
    if (typeof raw.faithful !== 'boolean') return null;
    // basis 枚举 → codeFirst 布尔：code=true，doc/mixed=false（含糊即不合格），n/a 或缺失=null。
    // 兼容旧输出里直接给 codeFirst 布尔的情况。
    let codeFirst: boolean | null = null;
    if (raw.basis === 'code') codeFirst = true;
    else if (raw.basis === 'doc' || raw.basis === 'mixed') codeFirst = false;
    else if (typeof raw.codeFirst === 'boolean') codeFirst = raw.codeFirst;
    const score = Number(raw.score);
    return {
      faithful: raw.faithful,
      correct: typeof raw.correct === 'boolean' ? raw.correct : null,
      codeFirst,
      coverage: computeCoverage(coverageChecklist, raw.coveredPoints),
      score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0,
      reasons: {
        faithful: raw.reasons?.faithful ?? '',
        correct: raw.reasons?.correct,
        codeFirst: raw.reasons?.codeFirst ?? raw.reasons?.basis,
        coverage: raw.reasons?.coverage,
      },
    };
  } catch {
    return null;
  }
}

/** coveredPoints（1-based 序号数组）→ CoverageVerdict；无 checklist 则 null。 */
function computeCoverage(checklist: string[] | undefined, coveredPoints: unknown): CoverageVerdict | null {
  if (!Array.isArray(checklist) || checklist.length === 0) return null;
  const hit = new Set(
    (Array.isArray(coveredPoints) ? coveredPoints : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= checklist.length),
  );
  const missing = checklist.filter((_, i) => !hit.has(i + 1));
  return { covered: hit.size, total: checklist.length, missing };
}

/** 多数票聚合：布尔取多数，score 取中位；correct/codeFirst 对 null 与非 null 混票时取非 null 多数侧。 */
export function aggregateVotes(votes: JudgeVerdict[]): JudgeVerdict {
  const majority = (xs: Array<boolean | null>): boolean | null => {
    const real = xs.filter((x): x is boolean => typeof x === 'boolean');
    if (real.length === 0) return null;
    return real.filter(Boolean).length * 2 >= real.length;
  };
  const scores = votes.map((v) => v.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] ?? 0;
  const pick = votes[0];
  // coverage 取「命中数中位」那一票（保留其 missing 列表的一致性），全为 null 则 null
  const covVotes = votes.map((v) => v.coverage).filter((c): c is CoverageVerdict => c !== null);
  let coverage: CoverageVerdict | null = null;
  if (covVotes.length > 0) {
    const sorted = [...covVotes].sort((a, b) => a.covered - b.covered);
    coverage = sorted[Math.floor(sorted.length / 2)];
  }
  return {
    faithful: majority(votes.map((v) => v.faithful)) ?? false,
    correct: majority(votes.map((v) => v.correct)),
    codeFirst: majority(votes.map((v) => v.codeFirst)),
    coverage,
    score: median,
    reasons: pick?.reasons ?? { faithful: '' },
  };
}

// ============ 缓存 ============

const CACHE_FILE = path.join(DATA_DIR, 'evalJudgeCache.json');

function cacheKey(input: JudgeInput, votes: number): string {
  const h = crypto.createHash('sha1');
  // judge 后端标识必须进 key：换独立 judge 模型后不能复用旧模型的票
  const judgeBackend = judgeHasOwnLlm ? `${JUDGE_LLM_BASE_URL}#${JUDGE_LLM_MODEL}` : 'main-llm';
  h.update([PROMPT_VERSION, judgeBackend, String(votes), input.question, input.answer, input.referenceAnswer ?? '', input.docSnippet ?? '', input.codeContext ?? '', (input.coverageChecklist ?? []).join('|'), JSON.stringify(input.evidence.map((e) => `${e.file}:${e.line}`))].join(' '));
  return h.digest('hex');
}

function readCache(): Record<string, JudgeVerdict[]> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, JudgeVerdict[]>;
  } catch {
    return {};
  }
}

/** 缓存条目上限：超过则按插入序淘汰最老的（JSON 对象键序即插入序）。 */
const CACHE_MAX_ENTRIES = 500;

function writeCache(cache: Record<string, JudgeVerdict[]>): void {
  try {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete cache[k];
    }
    // 原子写：先写临时文件再 rename（同目录内 rename 原子），避免 L4 线上采样
    // 与离线评测并发写时读到半截 JSON
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // 缓存写失败不致命
  }
}

// ============ 入口 ============

export { canUseLlm };

/**
 * 评审一条答案：votes 票（缓存命中则直接复用），聚合出最终裁决。
 * LLM 不可用或全部票解析失败 → null（调用方自行降级/报告）。
 */
export async function judgeAnswer(input: JudgeInput, votes = 3): Promise<{ verdict: JudgeVerdict; votes: JudgeVerdict[] } | null> {
  if (!canJudge()) return null;

  const cache = readCache();
  const key = cacheKey(input, votes);
  const collected = cache[key] ?? [];

  if (collected.length < votes) {
    const messages = buildJudgeMessages(input);
    for (let i = collected.length; i < votes; i++) {
      const text = await judgeLlmCall(messages);
      if (!text) continue;
      const verdict = parseJudgeJson(text, input.coverageChecklist);
      if (verdict) collected.push(verdict);
    }
    if (collected.length > 0) {
      cache[key] = collected;
      writeCache(cache);
    }
  }

  if (collected.length === 0) return null;
  return { verdict: aggregateVotes(collected), votes: collected };
}
