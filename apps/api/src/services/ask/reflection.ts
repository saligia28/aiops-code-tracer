/**
 * 自校验（Reflection）—— P0-A：把评测能力搬进生成循环，答案先自查再返回。
 *
 * 两级检查，先便宜后贵：
 *   L1 引用核对（默认开）：citationAccuracy 纯读盘、毫秒级、零 LLM 成本。
 *      答案引用的 file:line 大面积对不上 → 生成反馈让 LLM 重答一次。
 *   L2 judge 忠实度（默认关，REFLECT_JUDGE=1 显式开）：1 票 LLM 裁决，贵且慢，
 *      建议配合独立 judge 模型（JUDGE_LLM_*）使用，避免"自己批改自己"。
 *
 * 设计约束（改动前请读）：
 *   - 只做「检查 + 产出反馈文本」，不做重试——重试由调用方（routes/ask.ts）控制，
 *     因为重试要复用那里的完整 prompt 上下文；本模块保持纯粹、可单测。
 *   - 最多触发一次重试由调用方保证（防成本/延迟失控）。
 *   - 任何一步失败（读盘异常/judge 超时）都放行原答案——反思是增强不是闸门，
 *     宁可放过一个可疑答案，不能因为反思挂了导致用户拿不到回答。
 */
import type { Evidence } from '@aiops/shared-types';
import { citationAccuracy } from '../citationCheck.js';
import { judgeAnswer } from '../answerJudge.js';

/** L1 引用准确率低于该值触发重试。1=每条引用都必须核实；0=关闭 L1。 */
const CITATION_MIN = Math.max(0, Math.min(1, Number(process.env.REFLECT_CITATION_MIN || '0.8')));
/** L2 judge 反思开关（贵：每次答案多 1 次 LLM 调用），默认关。 */
const JUDGE_ENABLED = process.env.REFLECT_JUDGE === '1';

export interface ReflectionResult {
  /** true = 通过自查（或反思被禁用/不可用），答案可直接返回。 */
  pass: boolean;
  /** 不通过时给 LLM 的重答反馈（拼进对话让模型修正）；通过时为 null。 */
  feedback: string | null;
  /** 观测用元数据（进 trace，方便统计反思的真实收益）。 */
  meta: { citationAccuracy: number | null; judgeFaithful: boolean | null };
}

const PASS: ReflectionResult = { pass: true, feedback: null, meta: { citationAccuracy: null, judgeFaithful: null } };

/**
 * L1 反馈文案（T20）——按「重答时模型能不能重新取证」分化。
 *
 * 踩过的坑：原先只有 ask 那套措辞（"无法确认就别写行号"）。agent 重答禁用工具、
 * 早期工具结果已被折叠，模型改不对行号，于是选择了唯一的合规动作——**把引用全删**。
 * 结果是引用准确率这个指标变好了，可追溯性反而归零（活体：4633 字答案 0 条 file:line）。
 * 所以 agent 这套的核心是给出**降级路径**（写成"文件名（未确认行号）"），
 * 让"保留引用"始终比"删除引用"更容易执行。
 */
function buildCitationFeedback(bad: string, pipeline: 'ask' | 'agent'): string {
  const head = `你上一次回答里的部分代码引用与真实源码不符：\n${bad}\n`;
  if (pipeline === 'ask') {
    return `${head}请重新回答：只引用「相关代码」里真实出现的 文件:行号，无法确认的位置不要编造行号，改为在「证据不足」里说明。`;
  }
  return (
    // 首句必须先关掉工具意图：重答时 tools 传空数组只是让 API 不返回结构化 tool_call，
    // system prompt 里的工具目录还在——模型照样会"想调工具"，并把调用意图当**正文**吐出来
    // （实测 DeepSeek 会输出 DSML 标记，被当成最终答案原样下发）。forceFinalAnswer 有这句、
    // 反思重答原先没有，这是 T1 留下的口子。
    `${head}【系统指令】现在不要再调用任何工具，直接基于上文已收集的信息重写答案，并严格遵守以下引用纪律：\n` +
    '1. **保留原有的文件引用**。不要因为行号存疑就删掉整条引用——没有文件线索的答案无法核对，比行号写错更糟。\n' +
    '2. 上面列出的这几条：能从你之前读到的文件内容里确认正确行号的，改成正确行号；确认不了的，' +
    '把行号去掉、写成「文件名（未确认行号）」，**文件名必须留着**。\n' +
    '3. 没有被列出的引用是核对通过的，原样保留，不要动。\n' +
    '4. 不要新增你没有实际读到过的行号——宁可写「未确认行号」，也不要猜一个看起来合理的数字。'
  );
}

/**
 * 对一次回答做自查。
 * @param repoPath 被分析仓库磁盘路径；为空（项目未注册 repoPath）时跳过 L1。
 */
export async function reflectOnAnswer(input: {
  question: string;
  answer: string;
  evidence: Evidence[];
  repoPath: string;
  /** 答案生成时的代码上下文；L2 judge 口径对齐用（见 answerJudge PROMPT_VERSION v4）。 */
  codeContext?: string;
  /**
   * 重答时模型的**取证能力**决定反馈该怎么写（T20，活体实证的坑）：
   *   - 'ask'（默认）：codeContext 就在 prompt 里，模型能照着把行号改对，
   *     所以可以说"无法确认就别写行号"。
   *   - 'agent'：重答阶段**禁用了工具**，早期 read_file 结果又已被 compressMessages 折叠成面包屑，
   *     模型没有能力把行号改对——同一句话会被它执行成"把行号全删光"（实测：4633 字答案里
   *     file:line 引用归零）。所以必须显式要求「保留引用、只降级行号」。
   */
  pipeline?: 'ask' | 'agent';
}): Promise<ReflectionResult> {
  const meta: ReflectionResult['meta'] = { citationAccuracy: null, judgeFaithful: null };

  // ---- L1：引用核对（确定性，免费）----
  if (CITATION_MIN > 0 && input.repoPath && input.evidence.length > 0) {
    try {
      const result = citationAccuracy(input.evidence, input.repoPath);
      meta.citationAccuracy = result.accuracy;
      if (result.accuracy < CITATION_MIN) {
        const bad = result.checks
          .filter((c) => !c.matched)
          .slice(0, 5)
          .map((c) => `- ${c.evidence.file}:${c.evidence.line}（声称「${c.evidence.code.slice(0, 60)}」，${!c.fileExists ? '文件不存在' : !c.lineExists ? '行号越界' : '该行附近没有这个内容'}）`)
          .join('\n');
        return {
          pass: false,
          meta,
          feedback: buildCitationFeedback(bad, input.pipeline ?? 'ask'),
        };
      }
    } catch {
      // 读盘异常 → 放行（见头注：反思是增强不是闸门）
    }
  }

  // ---- L2：judge 忠实度（LLM，一票，显式开启才跑）----
  if (JUDGE_ENABLED) {
    try {
      const judged = await judgeAnswer({ question: input.question, answer: input.answer, evidence: input.evidence, codeContext: input.codeContext }, 1);
      if (judged) {
        meta.judgeFaithful = judged.verdict.faithful;
        if (!judged.verdict.faithful) {
          return {
            pass: false,
            meta,
            feedback: `质量评审认为你上一次回答不够忠实于代码证据：${judged.verdict.reasons.faithful}\n请重新回答：每个技术论断都要有「相关代码」或「证据线索」里的内容支撑，没有支撑的论断请删除或标注"证据不足"。`,
          };
        }
      }
    } catch {
      // judge 超时/异常 → 放行
    }
  }

  return { ...PASS, meta };
}
