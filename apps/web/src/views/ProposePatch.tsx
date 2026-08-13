import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { TokenUsagePanel } from '@/components/TokenUsagePanel';
import { useCurrentRepo } from '@/hooks/useCurrentRepo';
import { useProposePatch } from '@/hooks/useProposePatch';
import { useTokenUsageState } from '@/hooks/useTokenUsage';
import './ProposePatch.css';

type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
interface DiffLine {
  text: string;
  kind: DiffKind;
}

const FAIL_TEXT: Record<string, string> = {
  PATCH_NOT_APPLICABLE:
    '未能生成可干净应用的补丁。建议换更精确的目标文件（用问答/prepare_fix_context 重新定位），或把诉求写得更具体。',
  NO_CHANGE: '分析未产生任何改动。可能诉求已满足，或目标文件选得不对。',
  LLM_UNAVAILABLE: 'LLM 不可用。请检查分析服务的 LLM 配置。',
  NO_REPO: '未加载分析仓库。请先在顶部选择一个项目。',
  INVALID_INPUT: '目标文件无效。只允许修改仓库内已存在的文本文件（相对路径）。',
};

export default function ProposePatch() {
  const { currentRepo } = useCurrentRepo();
  const {
    result,
    loading,
    error,
    applyState,
    applyError,
    verifying,
    verifyResult,
    propose,
    apply,
    rollback,
    verify,
  } = useProposePatch();

  // 成本明细按需取（§13.1）：面板展开时才拉 events，摘要本身来自 propose 响应
  const { events: usageEvents, loading: usageLoading, fetchDetail } = useTokenUsageState();
  function loadUsageDetail(): void {
    const turnId = result?.turnId;
    if (turnId && !usageEvents[turnId]?.length) void fetchDetail(turnId);
  }

  const [question, setQuestion] = useState('');
  const [fileInput, setFileInput] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function addFile(): void {
    const f = fileInput.trim();
    if (f && !files.includes(f)) setFiles((prev) => [...prev, f]);
    setFileInput('');
  }

  function handleSubmit(): void {
    if (!question.trim() || files.length === 0 || loading) return;
    setConfirming(false);
    void propose(question.trim(), [...files]);
  }

  function currentProposalId(): string {
    return result && result.ok ? result.proposal.proposalId : '';
  }

  function doApply(): void {
    setConfirming(false);
    const id = currentProposalId();
    if (id) void apply(id);
  }

  function doRollback(): void {
    const id = currentProposalId();
    if (id) void rollback(id);
  }

  function doVerify(): void {
    const id = currentProposalId();
    if (id) void verify(id);
  }

  const verifyVerdictClass = (() => {
    if (!verifyResult || !verifyResult.ran) return 'neutral';
    return verifyResult.passed ? 'pass' : 'fail';
  })();

  async function copyDiff(): Promise<void> {
    if (!result || !result.ok) return;
    try {
      await navigator.clipboard.writeText(result.proposal.unifiedDiff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  const diffLines = useMemo<DiffLine[]>(() => {
    if (!result || !result.ok) return [];
    return result.proposal.unifiedDiff.split('\n').map((line): DiffLine => {
      // 顺序有讲究：hunk / meta 要在 add/del 之前判（"--- "/"+++ " 以 -/+ 开头但是元信息行）
      if (line.startsWith('@@')) return { text: line, kind: 'hunk' };
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ')
      ) {
        return { text: line, kind: 'meta' };
      }
      if (line.startsWith('+')) return { text: line, kind: 'add' };
      if (line.startsWith('-')) return { text: line, kind: 'del' };
      return { text: line, kind: 'ctx' };
    });
  }, [result]);

  const failText = !result || result.ok ? '' : FAIL_TEXT[result.reason] ?? `提案生成失败（${result.reason}）。`;

  return (
    <div className="propose">
      <PageHeader
        index="04"
        kicker="PATCH"
        title="修改提案"
        backTo="/"
        actions={currentRepo ? <span className="repo-tag">{currentRepo}</span> : undefined}
      />
      <p className="subtitle">
        描述要实现的修改 + 指定目标文件，AI 生成一份
        <strong>
          只读的、已通过 <code>git apply --check</code> 校验
        </strong>
        的补丁提案。{/* 迁移前模板里这里是换行，HTML 会折叠成一个空格；JSX 会吃掉换行空白，需显式补回 */}{' '}
        <strong>不会修改仓库任何文件</strong>——应用需人工审批。
      </p>

      <div className="form-card">
        <label className="field-label">修改诉求</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="question-input"
          rows={3}
          placeholder="例如：订单作废页——id 为空时应抛错提示，而不是静默 return"
          disabled={loading}
        />

        <label className="field-label">目标文件（仓库内相对路径，先用问答/prepare_fix_context 定位）</label>
        <div className="files-input">
          <input
            value={fileInput}
            onChange={(e) => setFileInput(e.target.value)}
            className="file-add"
            placeholder="如 src/api/orderVoid.ts，回车添加"
            onKeyUp={(e) => {
              if (e.key === 'Enter') addFile();
            }}
            disabled={loading}
          />
          <button className="add-btn" onClick={addFile} disabled={loading || !fileInput.trim()}>
            添加
          </button>
        </div>
        {files.length > 0 && (
          <div className="chips">
            {files.map((f, i) => (
              <span key={f} className="chip">
                {f}
                <button
                  className="chip-x"
                  onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={loading}
                  title="移除"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <button
          className="submit-btn"
          onClick={handleSubmit}
          disabled={loading || !question.trim() || files.length === 0}
        >
          {loading && <span className="spinner" />}
          {loading ? '生成中（走 LLM，可能数十秒）...' : '生成提案'}
        </button>
      </div>

      {/* 结构性错误（400/500） */}
      {error ? (
        <div className="notice error">
          <strong>请求失败：</strong>
          {error}
        </div>
      ) : result && !result.ok ? (
        /* 已处理的负结果（200 ok:false） */
        <div className="notice warn">
          <strong>未生成提案</strong>
          <p>{failText}</p>
          {result.detail && <p className="detail">技术细节：{result.detail}</p>}
          {result.attempts && <p className="detail">已尝试 {result.attempts} 次</p>}
          {/* 失败也花了钱（LLM 真调过）：照样交代成本（§13.1，评审 P6） */}
          {result.tokenUsageSummary && (
            <TokenUsagePanel
              summary={result.tokenUsageSummary}
              events={result.turnId ? usageEvents[result.turnId] : undefined}
              loading={result.turnId ? usageLoading[result.turnId] : false}
              onExpand={loadUsageDetail}
            />
          )}
        </div>
      ) : result && result.ok ? (
        /* 成功：提案 */
        <div className="result">
          <div className="banner">
            ✅ 已通过 <code>git apply --check</code>，可干净应用
            <span className="sep">·</span>
            ⚠️ 这是<strong>只读提案，尚未修改仓库</strong>，应用需人工审批
          </div>

          <div className="meta-card">
            <div className="meta-row">
              <span className="meta-k">仓库</span>
              <span className="meta-v">{result.proposal.repoName}</span>
            </div>
            <div className="meta-row">
              <span className="meta-k">提案 id</span>
              <span className="meta-v mono">{result.proposal.proposalId}</span>
            </div>
            <div className="meta-row">
              <span className="meta-k">校验于</span>
              <span className="meta-v">{result.proposal.validatedAt}</span>
            </div>
            <div className="meta-files">
              <span className="meta-k">涉及文件（{result.proposal.files.length}）</span>
              <ul>
                {result.proposal.files.map((f) => (
                  <li key={f.file}>
                    <span className="mono">{f.file}</span>
                    <span className="baseline" title="基线哈希（应用前会校验文件未变）">
                      基线 {f.baselineSha256.slice(0, 12)}…
                    </span>
                    {f.reason && <span className="reason">{f.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
            {/* 本次提案的 LLM 成本（§13.1，评审 P6）：数据直接来自响应，不写 conversation meta */}
            {result.tokenUsageSummary && (
              <TokenUsagePanel
                summary={result.tokenUsageSummary}
                events={result.turnId ? usageEvents[result.turnId] : undefined}
                loading={result.turnId ? usageLoading[result.turnId] : false}
                onExpand={loadUsageDetail}
              />
            )}
          </div>

          <div className="diff-card">
            <div className="diff-head">
              <span>统一 diff</span>
              <button className="copy-btn" onClick={copyDiff}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="diff-body">
              {diffLines.map((l, i) => (
                <div key={i} className={`dl ${l.kind}`}>
                  {l.text || ' '}
                </div>
              ))}
            </div>
          </div>

          {result.proposal.verifyCommands.length > 0 && (
            <div className="verify-card">
              <span className="meta-k">建议验证命令</span>
              {result.proposal.verifyCommands.map((c, i) => (
                <pre key={i} className="verify-cmd">
                  $ {c}
                </pre>
              ))}
            </div>
          )}

          {/* 审批门：apply / 回滚（唯一写盘入口，需二次确认） */}
          <div className="apply-section">
            {applyError && <div className="notice error">{applyError}</div>}

            {applyState === 'idle' ? (
              !confirming ? (
                <button className="apply-btn" onClick={() => setConfirming(true)}>
                  应用此提案（落盘到仓库）
                </button>
              ) : (
                <div className="confirm-box">
                  <p>
                    ⚠️ 这会<strong>真实修改</strong>仓库中的 {result.proposal.files.length}{' '}
                    个文件。落盘后可一键回滚。
                  </p>
                  <div className="confirm-actions">
                    <button className="danger-btn" onClick={doApply}>
                      确认落盘
                    </button>
                    <button className="ghost-btn" onClick={() => setConfirming(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )
            ) : applyState === 'applying' ? (
              <div className="apply-status">
                <span className="spinner dark" /> 落盘中...
              </div>
            ) : applyState === 'applied' ? (
              <div className="applied-block">
                <div className="apply-status applied">
                  <span>✅ 已落盘到仓库</span>
                  <div className="applied-actions">
                    <button className="ghost-btn" onClick={doVerify} disabled={verifying}>
                      {verifying && <span className="spinner dark" />}
                      {verifying ? '验证中...' : '运行验证'}
                    </button>
                    <button className="ghost-btn" onClick={doRollback}>
                      ↩ 回滚
                    </button>
                  </div>
                </div>

                {verifyResult && (
                  <div className={`verify-result ${verifyVerdictClass}`}>
                    {!verifyResult.ran ? (
                      <>⚠️ {verifyResult.message || '未运行验证（服务端未配置 VERIFY_COMMAND）'}</>
                    ) : (
                      <>
                        <div className="verify-head">
                          <strong>
                            {verifyResult.passed
                              ? '✅ 验证通过'
                              : verifyResult.timedOut
                                ? '⏱ 验证超时'
                                : '❌ 验证未通过'}
                          </strong>
                          {verifyResult.command && <code>$ {verifyResult.command}</code>}
                        </div>
                        {verifyResult.output && (
                          <pre className="verify-output">{verifyResult.output}</pre>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : applyState === 'rolling' ? (
              <div className="apply-status">
                <span className="spinner dark" /> 回滚中...
              </div>
            ) : applyState === 'rolled' ? (
              <div className="apply-status rolled">↩ 已回滚到落盘前状态</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
