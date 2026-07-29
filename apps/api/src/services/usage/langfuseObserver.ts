/**
 * Langfuse 观测出口（成本追踪 · 阶段 3）。
 *
 * 为什么要有它：移除 `lastCallMeta` 单例前必须先把 Langfuse 接到新通道上，否则
 * "删掉旧机制"会让观测侧的 token/成本**静默变空**——设计文档 §11.1 的顺序要求。
 *
 * 和旧机制的差别：
 *   - 旧：进程级单例，"调用后立刻同步读"，并发下会串账，且只覆盖 ask 主回答一次调用；
 *   - 新：请求级 tracker 的回调，agent 的每一轮、后台任务、patch 全都自动上报。
 *
 * prompt/输出正文只以**字符数**形式传给观测，不进 usage 表也不进 Langfuse 的 usage 字段。
 */
import type { AskTrace } from '../traceService.js';
import type { LlmUsageObserver } from './usageTracker.js';

export function createLangfuseObserver(trace: AskTrace | null): LlmUsageObserver | undefined {
  // 未配置 Langfuse 时 startAskTrace 返回 no-op facade，这里直接不挂 observer，省掉每次调用的对象构造
  if (!trace?.enabled) return undefined;
  return {
    onCallRecorded(usage, ephemeral) {
      trace.generation(usage.stage, ephemeral.startedAt, {
        model: usage.model,
        promptChars: ephemeral.promptChars,
        outputChars: ephemeral.outputChars,
        usage: {
          promptTokens: usage.tokens.promptTokens,
          completionTokens: usage.tokens.completionTokens,
          totalTokens: usage.tokens.totalTokens,
        },
      });
    },
  };
}
