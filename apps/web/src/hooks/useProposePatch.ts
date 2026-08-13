import { useCallback, useState } from 'react';
import http from '@/lib/http';
import type { TurnUsageSummary } from '@/hooks/useTokenUsage';

// ============================================================
// propose_patch（P2-G）前端调用
// 第一刀 /api/propose-patch：200 + 判别式 body（ok=true 带提案，ok=false 带 reason），仅 400/500 走 error。
// 第二刀 /api/apply-patch、/api/rollback（审批门）：语义 HTTP 码（403 未开权限/404/409/422），
//   失败走 axios catch，从 response 取服务端 message。
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

export type ProposeResult = (
  | { ok: true; proposal: Proposal; attempts?: number; note?: string }
  | { ok: false; reason: string; detail?: string; attempts?: number }
) & {
  /** 成本追踪（§13.1）：成功与业务失败都带——打不上的 diff 也是花过钱的 */
  turnId?: string;
  tokenUsageSummary?: TurnUsageSummary;
};

export type ApplyState = 'idle' | 'applying' | 'applied' | 'rolling' | 'rolled';

export interface VerifyResult {
  ran: boolean;
  passed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  command?: string;
  output?: string;
  reason?: string; // VERIFY_NOT_CONFIGURED
  message?: string;
}

function extractApplyError(e: unknown): string {
  const err = e as { response?: { status?: number; data?: { message?: string } } };
  if (err?.response?.status === 403) {
    return err.response.data?.message || '落盘功能未开启（需服务端设置 ALLOW_APPLY=true）';
  }
  return err?.response?.data?.message || '操作失败，请稍后重试';
}

export function useProposePatch() {
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const propose = useCallback(async (question: string, files: string[]): Promise<void> => {
    setLoading(true);
    setError(null);
    setResult(null);
    setApplyState('idle');
    setApplyError(null);
    setVerifyResult(null);
    try {
      const res = await http.post('/api/propose-patch', { question, files });
      setResult(res.data as ProposeResult);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      setError(err?.response?.data?.message || err?.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const apply = useCallback(async (proposalId: string): Promise<void> => {
    setApplyState('applying');
    setApplyError(null);
    try {
      const res = await http.post('/api/apply-patch', { proposalId, confirm: true });
      if (res.data?.ok) {
        setApplyState('applied');
      } else {
        setApplyState('idle');
        setApplyError(res.data?.message || '落盘失败');
      }
    } catch (e) {
      setApplyState('idle');
      setApplyError(extractApplyError(e));
    }
  }, []);

  const rollback = useCallback(async (proposalId: string): Promise<void> => {
    setApplyState('rolling');
    setApplyError(null);
    try {
      const res = await http.post('/api/rollback', { proposalId });
      setApplyState(res.data?.ok ? 'rolled' : 'applied');
      if (!res.data?.ok) setApplyError(res.data?.message || '回滚失败');
    } catch (e) {
      setApplyState('applied');
      setApplyError(extractApplyError(e));
    }
  }, []);

  const verify = useCallback(async (proposalId: string): Promise<void> => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await http.post('/api/verify', { proposalId });
      setVerifyResult(res.data as VerifyResult);
    } catch (e) {
      setVerifyResult({ ran: false, message: extractApplyError(e) });
    } finally {
      setVerifying(false);
    }
  }, []);

  return { result, loading, error, applyState, applyError, verifying, verifyResult, propose, apply, rollback, verify };
}
