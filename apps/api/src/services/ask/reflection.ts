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
          feedback: `你上一次回答里的部分代码引用与真实源码不符：\n${bad}\n请重新回答：只引用「相关代码」里真实出现的 文件:行号，无法确认的位置不要编造行号，改为在「证据不足」里说明。`,
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
