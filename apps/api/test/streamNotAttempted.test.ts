/**
 * 评审 P4：流式"没尝试"与"尝试失败"必须可区分。
 *
 * 纯内网（intranet 配好、无 API 兜底）时 callChatCompletionStream **发不出请求**
 * （ollama 流式协议未接，见 llmService 头注）。修复前调用方只看"是否 SSE"，
 * 该配置下所有 SSE 回答的非流式主调用都被记成 *_fallback——"流式失败率"从配置层面被污染（§11.1）。
 * canAttemptStreamLlm() 是调用方（answer.ts / routes/ask.ts）选 stage 的依据。
 *
 * 反向路径（能尝试且尝试了）由 usageAdapter.test.ts 的流式用例隐式覆盖：
 * 若 canAttemptStreamLlm 在 api+key 配置下误报 false，那些用例会因拿不到事件而挂。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

// intranet 已配置（模块加载时读取），API key 置空 = 无兜底
process.env.INTRANET_OLLAMA_BASE_URL = 'http://intranet-ollama:11434';
process.env.LLM_API_KEY = '';

const { llmRuntimeState } = await import('../src/context.ts');
const { callChatCompletionStream, canAttemptStreamLlm, canUseLlm } = await import('../src/services/llmService.ts');

afterAll(() => vi.unstubAllGlobals());

describe('P4 · 纯内网无 API 兜底', () => {
  it('canAttemptStreamLlm=false，流式返回 null 且不发任何请求', async () => {
    const prevMode = llmRuntimeState.mode;
    llmRuntimeState.mode = 'intranet';
    try {
      // 前提自检：LLM 可用（非流式会走 ollama），只是流式没有可用路径
      expect(canUseLlm()).toBe(true);
      expect(canAttemptStreamLlm()).toBe(false);

      const fetchSpy = vi.fn(async () => new Response('should not be called', { status: 500 }));
      vi.stubGlobal('fetch', fetchSpy);
      const r = await callChatCompletionStream([{ role: 'user', content: 'q' }], () => {});
      expect(r).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      llmRuntimeState.mode = prevMode;
    }
  });

  it('api 模式无 key：canUseLlm=false → 同样"没尝试"', () => {
    expect(llmRuntimeState.mode).toBe('api');
    expect(canAttemptStreamLlm()).toBe(false);
  });
});
