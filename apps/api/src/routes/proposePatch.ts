import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { currentRepoPath, currentRepoName } from '../context.js';
import { canUseLlm, callChatCompletion } from '../services/llmService.js';
import { proposePatch } from '../services/patch/proposePatch.js';

// ============================================================
// POST /api/propose-patch（P2-G1 · 写侧第一刀，只读提案不落盘）
// 调用方先经 prepare_fix_context 选定目标文件，这里只负责：读当前原文 → LLM 生成 →
// 确定性 gate 硬校验 → 回结构化提案。全程不写被分析仓库；无 apply 端点即无写盘路径。
//
// 响应约定：已处理的结果（含"打不上/无改动/LLM 不可用/未加载仓库"等负结果）一律
// **HTTP 200 + 判别式 body**（{ok:true,...} | {ok:false,reason,...}），让 MCP/前端按 ok
// 字段判，而非跟 HTTP 错误映射较劲（MCP client 把 503 一律当"未加载仓库"会串味）。
// 只有结构性坏请求（400）与未预期崩溃（500）才走非 2xx。
// ============================================================

export function registerProposePatch(app: FastifyInstance): void {
  app.post('/api/propose-patch', async (request, reply) => {
    const body = request.body as { question?: string; files?: string[]; evidenceRefs?: unknown[] };

    // 结构性坏请求 → 400（调用方契约违背）
    if (!body?.question || !body.question.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: 'files 需为非空数组（先经 prepare_fix_context 选定目标文件）' });
    }

    // 已处理的负结果 → 200 + 判别式 body（见文件头注释）
    if (!currentRepoPath) {
      return { ok: false, reason: 'NO_REPO', detail: '未加载分析仓库（请先在 Web 界面选中一个项目）' };
    }
    if (!canUseLlm()) {
      return { ok: false, reason: 'LLM_UNAVAILABLE', detail: 'LLM 未配置或不可用' };
    }

    // 断连即中止：客户端超时断开后别再空烧 LLM（与 ask 路由同口径，监听响应侧 close）
    const abortCtl = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abortCtl.abort();
    });

    try {
      const result = await proposePatch(
        {
          question: body.question,
          files: body.files,
          repoName: currentRepoName ?? 'unknown',
          evidenceRefs: body.evidenceRefs,
        },
        currentRepoPath,
        {
          llm: callChatCompletion,
          now: () => new Date().toISOString(),
          newId: () => crypto.randomUUID(),
          signal: abortCtl.signal,
        },
      );

      if (result.ok) {
        return {
          ok: true,
          proposal: result.proposal,
          attempts: result.attempts,
          note: '仅生成提案，未修改被分析仓库任何文件',
        };
      }
      return { ok: false, reason: result.error, detail: result.detail, attempts: result.attempts };
    } catch (err) {
      app.log.error(`propose-patch 失败: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ error: 'PROPOSE_FAILED', message: '提案生成失败，请稍后重试' });
    }
  });
}
