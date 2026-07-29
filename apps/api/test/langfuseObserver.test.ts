/**
 * Langfuse observer（成本追踪 · 阶段 3）。
 *
 * 这套测试守的是一个**顺序约束**：`lastCallMeta` 单例已被删除，如果 observer 这条新通道
 * 没接好，Langfuse 的 token/成本会静默变空——观测退化不会报错，只会某天发现图表没数据。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { AskTrace } from '../src/services/traceService.ts';

const TMP_DB = path.join(os.tmpdir(), `aiops-usage-observer-${crypto.randomUUID()}.db`);
process.env.AIOPS_DB_PATH = TMP_DB;
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key-observer';

const { createUsageTracker } = await import('../src/services/usage/usageTracker.ts');
const { createLangfuseObserver } = await import('../src/services/usage/langfuseObserver.ts');
const { callChatCompletion } = await import('../src/services/llmService.ts');

afterAll(() => {
  vi.unstubAllGlobals();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TMP_DB + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
});

interface Generation {
  name: string;
  meta: { model?: string; usage?: { promptTokens?: number; totalTokens?: number }; promptChars?: number };
}

function fakeTrace(enabled: boolean, sink: Generation[]): AskTrace {
  return {
    enabled,
    span: () => {},
    generation: (name, _startMs, meta) => sink.push({ name, meta }),
    end: () => {},
    error: () => {},
  } as unknown as AskTrace;
}

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '答案' } }],
          usage: {
            prompt_tokens: 400,
            prompt_cache_hit_tokens: 100,
            prompt_cache_miss_tokens: 300,
            completion_tokens: 60,
            total_tokens: 460,
          },
        }),
        { status: 200 },
      ),
    ),
  );
});

describe('Langfuse observer', () => {
  it('每次真实调用都上报 model + token（删掉 lastCallMeta 后 Langfuse 不能断供）', async () => {
    const sink: Generation[] = [];
    const tracker = createUsageTracker({
      projectId: 'p',
      pipeline: 'ask',
      source: 'web',
      observer: createLangfuseObserver(fakeTrace(true, sink)),
    });

    await callChatCompletion([{ role: 'user', content: 'q' }], undefined, {
      tracker,
      stage: 'ask.answer_complex',
    });

    expect(sink).toHaveLength(1);
    expect(sink[0].name).toBe('ask.answer_complex'); // 用 stage 作为 generation 名，比旧的固定 'answer' 更细
    expect(sink[0].meta.model).toBeTruthy();
    expect(sink[0].meta.usage?.totalTokens).toBe(460);
    expect(sink[0].meta.usage?.promptTokens).toBe(400);
  });

  it('agent 多轮：每轮各上报一次（旧单例只覆盖得到 ask 主回答那一次）', async () => {
    const sink: Generation[] = [];
    const tracker = createUsageTracker({
      projectId: 'p',
      pipeline: 'agent',
      source: 'web',
      observer: createLangfuseObserver(fakeTrace(true, sink)),
    });
    for (const stage of ['agent.planner', 'agent.loop', 'agent.loop'] as const) {
      await callChatCompletion([{ role: 'user', content: 'q' }], undefined, { tracker, stage });
    }
    expect(sink.map((g) => g.name)).toEqual(['agent.planner', 'agent.loop', 'agent.loop']);
  });

  it('Langfuse 未配置（trace.enabled=false）→ 不挂 observer，主链路零额外开销', () => {
    expect(createLangfuseObserver(fakeTrace(false, []))).toBeUndefined();
    expect(createLangfuseObserver(null)).toBeUndefined();
  });

  it('observer 抛异常不影响问答与记账（观测永远不能反噬主链路）', async () => {
    const tracker = createUsageTracker({
      projectId: 'p',
      pipeline: 'ask',
      source: 'web',
      observer: {
        onCallRecorded: () => {
          throw new Error('langfuse down');
        },
      },
    });
    const text = await callChatCompletion([{ role: 'user', content: 'q' }], undefined, {
      tracker,
      stage: 'ask.answer_simple',
    });
    expect(text).toBe('答案');
    expect(tracker.summary().callCount).toBe(1);
  });

  it('只传字符数、不传正文（prompt/回答不进观测的 usage 字段）', async () => {
    const sink: Generation[] = [];
    const tracker = createUsageTracker({
      projectId: 'p',
      pipeline: 'ask',
      source: 'web',
      observer: createLangfuseObserver(fakeTrace(true, sink)),
    });
    await callChatCompletion([{ role: 'user', content: '一段很长的敏感提示词内容' }], undefined, {
      tracker,
      stage: 'ask.intent',
    });
    expect(sink[0].meta.promptChars).toBeGreaterThan(0);
    expect(JSON.stringify(sink[0])).not.toContain('敏感提示词');
  });
});
