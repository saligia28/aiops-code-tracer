import { ref } from 'vue';
import http from '@/lib/http';

// ============================================================
// propose_patch（P2-G · 写侧第一刀）前端调用
// /api/propose-patch 返回 200 + 判别式 body：ok=true 带提案，ok=false 带 reason；
// 只有结构性坏请求(400)/崩溃(500)才抛（走 error）。
// ============================================================

export interface ProposalFile {
  file: string;
  baselineSha256: string;
  reason: string;
}

export interface Proposal {
  proposalId: string;
  repoName: string;
  question: string;
  unifiedDiff: string;
  files: ProposalFile[];
  verifyCommands: string[];
  validatedAt: string;
}

export type ProposeResult =
  | { ok: true; proposal: Proposal; attempts?: number; note?: string }
  | { ok: false; reason: string; detail?: string; attempts?: number };

export function useProposePatch() {
  const result = ref<ProposeResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function propose(question: string, files: string[]): Promise<void> {
    loading.value = true;
    error.value = null;
    result.value = null;
    try {
      const res = await http.post('/api/propose-patch', { question, files });
      result.value = res.data as ProposeResult;
    } catch (e: unknown) {
      // 400/500：结构性坏请求或崩溃（其余负结果是 200 + ok:false，不走这里）
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      error.value = err?.response?.data?.message || err?.message || '请求失败';
    } finally {
      loading.value = false;
    }
  }

  function reset(): void {
    result.value = null;
    error.value = null;
  }

  return { result, loading, error, propose, reset };
}
