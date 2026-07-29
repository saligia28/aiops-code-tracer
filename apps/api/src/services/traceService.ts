/**
 * L4 观测层 —— Langfuse 封装（检测/Tracing）
 *
 * 选型：Langfuse（开源、可自托管，契合本项目"全家桶自己 Docker 跑"的叙事；
 * 不需要引入 LangChain，SDK 直连 OpenAI 兼容后端也能用）。
 *
 * 两条铁律：
 *  1. env 未配置（缺 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY）→ 完全 no-op，
 *     问答链路一行不多跑；facade 方法全部可安全调用。
 *  2. fail-open：Langfuse 服务挂了只影响观测，绝不影响问答——SDK 异步批量上报，
 *     网络错误被吞掉（记 warn），主链路无感。
 *
 * 亮点：LANGFUSE_JUDGE_SAMPLE ∈ [0,1] 抽样率——被抽中的问答，fire-and-forget 调
 * L3 的 judge（1 票，省成本）打忠实度/总分，作为 score 回写到对应 trace 上。
 * 这就是「线上回归告警」的最小闭环：Langfuse 里可直接按 faithful=0 过滤告警。
 */
import { Langfuse } from 'langfuse';
import type { FastifyBaseLogger } from 'fastify';
import type { Evidence } from '@aiops/shared-types';
import { judgeAnswer } from './answerJudge.js';
import type { LlmUsageContext } from './usage/usageTracker.js';
import { sendAlert } from './alertService.js';

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? '';
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY?.trim() ?? '';
const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? '').trim().replace(/\/+$/, '');
/** 线上抽样送 judge 的比例，0=关闭（默认）。 */
const JUDGE_SAMPLE = Math.max(0, Math.min(1, Number(process.env.LANGFUSE_JUDGE_SAMPLE || '0')));
/**
 * 隐私开关：question / 答案预览属于「源码语义」（真实路径、函数名、业务逻辑）。
 * 默认脱敏（只报长度），显式设 LANGFUSE_LOG_PAYLOADS=1 才上报明文——
 * 自托管环境打开没问题；指向 Langfuse Cloud 时打开等于把企业代码语义送出网。
 */
const LOG_PAYLOADS = process.env.LANGFUSE_LOG_PAYLOADS === '1';
/** 抽样 judge 成本护栏：每小时最多 N 次（默认 20），并发最多 1。 */
const JUDGE_HOURLY_MAX = Math.max(0, Number(process.env.LANGFUSE_JUDGE_HOURLY_MAX || '20'));

function redactText(text: string): string | { chars: number } {
  return LOG_PAYLOADS ? text : { chars: text.length };
}

let client: Langfuse | null = null;
let _log: FastifyBaseLogger | undefined;

export function setTraceServiceLogger(log: FastifyBaseLogger): void {
  _log = log;
}

export function canTrace(): boolean {
  return Boolean(PUBLIC_KEY && SECRET_KEY);
}

function getClient(): Langfuse | null {
  if (!canTrace()) return null;
  if (!client) {
    client = new Langfuse({
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
      requestTimeout: 5000,
    });
    // fail-open：SDK 内部批量上报失败只记日志，不抛给业务
    client.on('error', (err: unknown) => {
      _log?.warn(`[langfuse] 上报失败（不影响问答）: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!BASE_URL) {
      _log?.warn('[langfuse] 未设 LANGFUSE_BASE_URL，trace 将上报到 Langfuse Cloud（出网）；payload 默认已脱敏，明文需显式 LANGFUSE_LOG_PAYLOADS=1');
    }
  }
  return client;
}

// ============ 抽样 judge 成本护栏（并发 1 + 小时配额） ============

let judgeInFlight = false;
let judgeHourWindow = 0;
let judgeHourCount = 0;

/** 是否放行本次抽样 judge：小时窗口配额 + 单并发（都不满足则静默跳过，不排队）。 */
function acquireJudgeSlot(nowMs: number): boolean {
  if (JUDGE_HOURLY_MAX <= 0) return false;
  const hour = Math.floor(nowMs / 3_600_000);
  if (hour !== judgeHourWindow) {
    judgeHourWindow = hour;
    judgeHourCount = 0;
  }
  if (judgeInFlight || judgeHourCount >= JUDGE_HOURLY_MAX) return false;
  judgeInFlight = true;
  judgeHourCount += 1;
  return true;
}

/** 进程退出前把批量队列冲干净（no-op 模式下什么都不做）。 */
export async function shutdownTracing(): Promise<void> {
  try {
    await client?.shutdownAsync();
  } catch {
    // fail-open
  }
}

// ============ ask 链路 facade ============

export interface AskTrace {
  /**
   * 是否真的在上报（Langfuse 已配置）。调用方给 span 组装昂贵 metadata（如整段 prompt
   * 的 token 估算）前先看它——no-op facade 不判空的便利不该换来白算一遍的开销。
   */
  enabled: boolean;
  /** 记录一个已完成的阶段（用起止时间回填 span）。 */
  span(name: string, startMs: number, metadata?: Record<string, unknown>): void;
  /** 记录主 LLM 生成（问答那次大调用），usage 有则透传给 Langfuse 的成本统计。 */
  generation(name: string, startMs: number, meta: {
    model?: string;
    promptChars?: number;
    outputChars?: number;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  }): void;
  /**
   * 成功收尾：回填输出摘要 + 按抽样率**判定**是否送 judge。
   * 命中采样时返回惰性任务，由路由登记后台句柄后再启动（成本追踪 · 阶段 3）——
   * end() 自己不再启动 Promise，否则这次 LLM 调用不属于任何 turn。
   */
  end(out: { answer: string; evidence: Evidence[]; intent: string; confidence: number; answeredByLlm: boolean }):
    | { startJudge: (usage?: LlmUsageContext) => Promise<void> }
    | undefined;
  /** 异常收尾。 */
  error(err: unknown): void;
}

const NOOP_TRACE: AskTrace = {
  enabled: false,
  span: () => {},
  generation: () => {},
  end: () => undefined,
  error: () => {},
};

/**
 * 为一次 /api/ask 开 trace。未配置 Langfuse 时返回 no-op facade——调用方无需判空。
 */
export function startAskTrace(input: {
  question: string;
  projectId?: string | null;
  conversationId?: string | null;
  repoName?: string | null;
  /** trace 名称：默认 'ask'（RAG 管线）；agent 管线传 'agent'。 */
  name?: string;
  /** 调用来源（如 'mcp'）——机器流量与人类流量在观测上必须可分。 */
  source?: string;
}): AskTrace {
  const lf = getClient();
  if (!lf) return NOOP_TRACE;

  const trace = lf.trace({
    name: input.name ?? 'ask',
    input: { question: redactText(input.question) },
    metadata: {
      projectId: input.projectId ?? undefined,
      conversationId: input.conversationId ?? undefined,
      repoName: input.repoName ?? undefined,
      source: input.source ?? undefined,
      payloadsRedacted: !LOG_PAYLOADS,
    },
  });

  return {
    enabled: true,
    span(name, startMs, metadata) {
      trace.span({ name, startTime: new Date(startMs), endTime: new Date(), metadata });
    },
    generation(name, startMs, meta) {
      trace.generation({
        name,
        startTime: new Date(startMs),
        endTime: new Date(),
        model: meta.model,
        ...(meta.usage ? { usage: meta.usage } : {}),
        metadata: { promptChars: meta.promptChars, outputChars: meta.outputChars },
      });
    },
    end(out) {
      trace.update({
        output: {
          answerPreview: redactText(out.answer.slice(0, 400)),
          evidenceCount: out.evidence.length,
          intent: out.intent,
          confidence: out.confidence,
          answeredByLlm: out.answeredByLlm,
        },
      });

      // 线上抽样 → L3 judge 打分回写。
      // 成本护栏：单并发 + 小时配额——sample 误配成 1 也不会把每个请求都变成额外 LLM 调用。
      // 空 evidence 不判（忠实度以证据为锚，硬判只会产出噪声分）。
      //
      // 成本追踪（阶段 3）：这里**只做采样判定**，不再自行启动 Promise。命中时返回惰性
      // startJudge，由路由登记 background.trace_judge 句柄后再启动——否则这次 LLM 调用
      // 既不在任何 turn 里，也不会让 turn 等它，成本就漏了。
      // 并发槽同样推迟到真正启动时才取：判定阶段就占槽会让相邻请求的采样被白白挤掉。
      if (JUDGE_SAMPLE > 0 && out.evidence.length > 0 && Math.random() < JUDGE_SAMPLE) {
        return {
          startJudge: (usage?: LlmUsageContext) => {
            if (!acquireJudgeSlot(Date.now())) return Promise.resolve();
            return runJudge(usage);
          },
        };
      }
      return undefined;

      function runJudge(usage?: LlmUsageContext): Promise<void> {
        return judgeAnswer(
          { question: input.question, answer: out.answer, evidence: out.evidence },
          1, // 线上抽样用 1 票省成本；离线评测才用 3 票
          usage,
        )
          .then((judged) => {
            if (!judged) return;
            lf?.score({ traceId: trace.id, name: 'faithful', value: judged.verdict.faithful ? 1 : 0, comment: judged.verdict.reasons.faithful });
            lf?.score({ traceId: trace.id, name: 'judge_score', value: judged.verdict.score });
            // 线上回归告警闭环：判不忠实 → 推现有告警通道（钉钉/飞书，未配 ALERT_WEBHOOK 则 no-op）
            if (!judged.verdict.faithful) {
              void sendAlert(
                '线上答案忠实度告警（抽样 judge）',
                [
                  `问题: ${input.question.slice(0, 80)}`,
                  `评分: ${judged.verdict.score}/10`,
                  `理由: ${judged.verdict.reasons.faithful.slice(0, 120)}`,
                  `trace: ${trace.id}`,
                ],
                'warning',
                _log,
              );
            }
          })
          .catch((err) => {
            _log?.warn(`[langfuse] 抽样 judge 失败（不影响问答）: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => {
            judgeInFlight = false;
          });
      }
    },
    error(err) {
      const message = err instanceof Error ? err.message : String(err)
      // level=ERROR 事件让 Langfuse 侧可以直接按级别过滤/告警，而不是靠 metadata 约定
      trace.event({ name: 'ask_failed', level: 'ERROR', statusMessage: message });
      trace.update({
        output: { error: message },
        metadata: { failed: true },
      });
    },
  };
}
