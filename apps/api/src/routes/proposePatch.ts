import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { currentRepoPath, currentRepoName } from '../context.js';
import { canUseLlm, callChatCompletion } from '../services/llmService.js';
import { proposePatch } from '../services/patch/proposePatch.js';
import { applyPatch, rollbackPatch } from '../services/patch/applyPatch.js';
import { runVerify, getVerifyCommand } from '../services/patch/verifyRunner.js';
import { insertProposal, getProposal, appendAudit } from '../db/patchStore.js';

// ============================================================
// 补丁提案端点（P2-G）
// 第一刀 /api/propose-patch：读原文 → LLM 生成 → 确定性 gate → 回结构化提案（只读，不落盘）。
//   已处理结果一律 200 + 判别式 body（{ok:true}|{ok:false,reason}），只有结构性坏请求 400/崩溃
//   500 才非 2xx（否则 MCP client 把 503 一律当"未加载仓库"串味）。成功即落库，返回 proposalId。
// 第二刀 /api/apply-patch、/api/rollback：审批门——系统唯一写被分析仓库的路径。三重闸：
//   ① ALLOW_APPLY env 权限位（默认关，只读部署无写盘可能）
//   ② confirm:true 人工二次确认（apply）
//   ③ 落盘前重校验基线 + 再跑 git apply --check（在 applyPatch 核心内）
//   MCP 侧不暴露 apply/rollback——HITL 的本意是人来把关。
// ============================================================

/** 落盘总开关（默认关）：只读部署下 apply/rollback 直接 403，从根上没有写盘可能。 */
function applyEnabled(): boolean {
  const v = (process.env.ALLOW_APPLY ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function registerProposePatch(app: FastifyInstance): void {
  app.post('/api/propose-patch', async (request, reply) => {
    const body = request.body as { question?: string; files?: string[]; evidenceRefs?: unknown[] };

    if (!body?.question || !body.question.trim()) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 question 参数' });
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: 'files 需为非空数组（先经 prepare_fix_context 选定目标文件）' });
    }
    if (!currentRepoPath) {
      return { ok: false, reason: 'NO_REPO', detail: '未加载分析仓库（请先在 Web 界面选中一个项目）' };
    }
    if (!canUseLlm()) {
      return { ok: false, reason: 'LLM_UNAVAILABLE', detail: 'LLM 未配置或不可用' };
    }

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
        // 落库（status=proposed）：apply 按 id 审批，审批的正是这份校验过的原件。
        // 落库失败不阻断预览（用户仍看得到 diff），但会在 apply 时 404——记日志便于排查。
        try {
          insertProposal({
            id: result.proposal.proposalId,
            repoName: result.proposal.repoName,
            question: result.proposal.question,
            unifiedDiff: result.proposal.unifiedDiff,
            files: result.proposal.files.map((f) => ({ file: f.file, baselineSha256: f.baselineSha256, reason: f.reason })),
            verifyCommands: result.proposal.verifyCommands,
            validatedAt: result.proposal.validatedAt,
          });
        } catch (err) {
          app.log.error(`提案落库失败: ${err instanceof Error ? err.message : String(err)}`);
        }
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

  // ---- 审批门：apply（唯一写盘路径）----
  app.post('/api/apply-patch', async (request, reply) => {
    if (!applyEnabled()) {
      return reply.code(403).send({ error: 'APPLY_DISABLED', message: '落盘功能未开启（需服务端设置 ALLOW_APPLY=true）' });
    }
    const body = request.body as { proposalId?: string; confirm?: boolean };
    if (!body?.proposalId) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 proposalId' });
    }
    if (body.confirm !== true) {
      return reply.code(400).send({ error: 'CONFIRM_REQUIRED', message: '需显式 confirm:true（人工二次确认后方可落盘）' });
    }
    if (!currentRepoPath) {
      return reply.code(409).send({ error: 'NO_REPO', message: '未加载分析仓库' });
    }
    try {
      const result = await applyPatch(body.proposalId, currentRepoPath);
      if (result.ok) {
        return { ok: true, appliedFiles: result.appliedFiles, note: '已落盘；如需撤销可一键回滚' };
      }
      const code = result.reason === 'NOT_FOUND' ? 404 : result.reason === 'BAD_STATUS' ? 409 : 422;
      return reply.code(code).send({ ok: false, error: result.reason, message: result.detail });
    } catch (err) {
      app.log.error(`apply-patch 失败: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ error: 'APPLY_FAILED', message: '落盘失败，请稍后重试' });
    }
  });

  // ---- 回滚：写回落盘前的原始字节（撤销 apply）----
  app.post('/api/rollback', async (request, reply) => {
    if (!applyEnabled()) {
      return reply.code(403).send({ error: 'APPLY_DISABLED', message: '落盘功能未开启（需服务端设置 ALLOW_APPLY=true）' });
    }
    const body = request.body as { proposalId?: string };
    if (!body?.proposalId) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 proposalId' });
    }
    if (!currentRepoPath) {
      return reply.code(409).send({ error: 'NO_REPO', message: '未加载分析仓库' });
    }
    try {
      const result = await rollbackPatch(body.proposalId, currentRepoPath);
      if (result.ok) {
        return { ok: true, restoredFiles: result.restoredFiles, note: '已回滚到落盘前状态' };
      }
      const code = result.reason === 'NOT_FOUND' ? 404 : result.reason === 'BAD_STATUS' ? 409 : 422;
      return reply.code(code).send({ ok: false, error: result.reason, message: result.detail });
    } catch (err) {
      app.log.error(`rollback 失败: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ error: 'ROLLBACK_FAILED', message: '回滚失败，请稍后重试' });
    }
  });

  // ---- 沙箱验证（第三刀 · 就地后验）：apply 后在真实环境跑配置的 lint/test ----
  // 命令来自 env VERIFY_COMMAND（可信），不跑 LLM/提案里的命令。测试失败(passed=false)不是
  // 传输错误——verify 跑完了、结论是不过，仍 200；pass/fail 在 body。
  app.post('/api/verify', async (request, reply) => {
    if (!applyEnabled()) {
      return reply.code(403).send({ error: 'APPLY_DISABLED', message: '落盘/验证功能未开启（需服务端设置 ALLOW_APPLY=true）' });
    }
    const body = request.body as { proposalId?: string };
    if (!body?.proposalId) {
      return reply.code(400).send({ error: 'INVALID_PARAMS', message: '缺少 proposalId' });
    }
    if (!currentRepoPath) {
      return reply.code(409).send({ error: 'NO_REPO', message: '未加载分析仓库' });
    }
    const proposal = getProposal(body.proposalId);
    if (!proposal) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `提案不存在：${body.proposalId}` });
    }
    if (proposal.status !== 'applied') {
      return reply.code(409).send({ error: 'BAD_STATUS', message: `提案状态为 ${proposal.status}，需先 apply 再验证` });
    }
    if (!getVerifyCommand()) {
      return { ran: false, reason: 'VERIFY_NOT_CONFIGURED', message: '服务端未配置 VERIFY_COMMAND（如 pnpm -C apps/api test）' };
    }
    try {
      const result = await runVerify(currentRepoPath);
      appendAudit(body.proposalId, 'verify', result.passed ? 'ok' : 'fail', `exit=${result.exitCode} timedOut=${result.timedOut}`);
      return {
        ran: true,
        passed: result.passed,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        command: result.command,
        output: result.output,
      };
    } catch (err) {
      app.log.error(`verify 失败: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ error: 'VERIFY_FAILED', message: '验证执行失败，请稍后重试' });
    }
  });
}
