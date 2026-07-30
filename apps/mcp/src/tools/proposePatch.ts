import { z } from 'zod';
import { analyzerPost, getRepoLock } from '../client.js';
import { formatProposal, type ProposePatchResponse } from '../format.js';
import { text, type ToolDescriptor } from './types.js';

/**
 * 与 ask 同款长超时：走完整 LLM 生成 + 有界重试（每轮一次 LLM，最多 2 轮），
 * 全局 30s 不够。消费端自己的 MCP 工具超时也需 ≥ 此值。
 */
const PROPOSE_TIMEOUT_MS = Number(process.env.ANALYZER_PROPOSE_TIMEOUT_MS) || 120_000;

export const proposePatch: ToolDescriptor = {
  name: 'propose_patch',
  config: {
    description:
      '基于「要改什么」+「改哪些文件」生成一份【只读的修改提案】：统一 diff + 每个文件的基线哈希 + 验证建议，且已用 git apply --check 确认能干净打上——但绝不修改仓库任何文件（无落盘路径，应用需人工审批，本工具不做）。用法：先用 prepare_fix_context 定位"要改哪些文件"，再把这些文件的仓库内相对路径连同修改诉求传进来。只能修改已存在的文本文件（不支持新增/删除/改名）。走 LLM、耗时数十秒。',
    inputSchema: {
      question: z
        .string()
        .trim()
        .min(1, 'question 不能为空')
        .describe('要实现的修改，写清意图，例如"订单作废：id 为空时应抛错而非静默 return"。'),
      files: z
        .array(z.string().trim().min(1))
        .min(1, '至少一个目标文件')
        .max(10, '目标文件不超过 10 个')
        .describe('目标文件的仓库内相对路径（来自 prepare_fix_context 的疑似修改点/入口）。'),
    },
  },
  handler: async (args) => {
    const { question, files } = args as { question: string; files: string[] };
    const data = await analyzerPost<ProposePatchResponse>(
      '/api/propose-patch',
      // source=mcp：成本按来源分组（§11.5）。不带的话服务端按 web 兜底，MCP 的 patch 开销全记错组
      { question, files, source: 'mcp' },
      { timeoutMs: PROPOSE_TIMEOUT_MS },
    );
    // 锁仓 post-check（同 prepare_fix_context）：pre-check 通过后、生成完成前仓库仍可能被切走
    const lock = getRepoLock();
    const respRepo = data.ok ? data.proposal.repoName : undefined;
    const warn =
      lock && respRepo && respRepo !== lock
        ? `⚠️ 生成过程中仓库被切换：本提案来自 ${respRepo}，而非锁定的 ${lock}，请勿采信。\n\n`
        : '';
    return text(warn + formatProposal(data));
  },
};
