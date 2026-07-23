<template>
  <div class="propose">
    <PageHeader index="04" kicker="PATCH" title="修改提案" :back-to="{ name: 'Home' }">
      <template #actions>
        <span class="repo-tag" v-if="currentRepo">{{ currentRepo }}</span>
      </template>
    </PageHeader>
    <p class="subtitle">
      描述要实现的修改 + 指定目标文件，AI 生成一份<strong>只读的、已通过 <code>git apply --check</code> 校验</strong>的补丁提案。
      <strong>不会修改仓库任何文件</strong>——应用需人工审批。
    </p>

    <div class="form-card">
      <label class="field-label">修改诉求</label>
      <textarea
        v-model="question"
        class="question-input"
        rows="3"
        placeholder="例如：订单作废页——id 为空时应抛错提示，而不是静默 return"
        :disabled="loading"
      />

      <label class="field-label">目标文件（仓库内相对路径，先用问答/prepare_fix_context 定位）</label>
      <div class="files-input">
        <input
          v-model="fileInput"
          class="file-add"
          placeholder="如 src/api/orderVoid.ts，回车添加"
          @keyup.enter="addFile"
          :disabled="loading"
        />
        <button class="add-btn" @click="addFile" :disabled="loading || !fileInput.trim()">添加</button>
      </div>
      <div class="chips" v-if="files.length">
        <span v-for="(f, i) in files" :key="f" class="chip">
          {{ f }}
          <button class="chip-x" @click="files.splice(i, 1)" :disabled="loading" title="移除">×</button>
        </span>
      </div>

      <button
        class="submit-btn"
        @click="handleSubmit"
        :disabled="loading || !question.trim() || files.length === 0"
      >
        <span v-if="loading" class="spinner" />
        {{ loading ? '生成中（走 LLM，可能数十秒）...' : '生成提案' }}
      </button>
    </div>

    <!-- 结构性错误（400/500） -->
    <div class="notice error" v-if="error">
      <strong>请求失败：</strong>{{ error }}
    </div>

    <!-- 已处理的负结果（200 ok:false） -->
    <div class="notice warn" v-else-if="result && !result.ok">
      <strong>未生成提案</strong>
      <p>{{ failText }}</p>
      <p class="detail" v-if="result.detail">技术细节：{{ result.detail }}</p>
      <p class="detail" v-if="result.attempts">已尝试 {{ result.attempts }} 次</p>
    </div>

    <!-- 成功：提案 -->
    <div class="result" v-else-if="result && result.ok">
      <div class="banner">
        ✅ 已通过 <code>git apply --check</code>，可干净应用
        <span class="sep">·</span>
        ⚠️ 这是<strong>只读提案，尚未修改仓库</strong>，应用需人工审批
      </div>

      <div class="meta-card">
        <div class="meta-row">
          <span class="meta-k">仓库</span><span class="meta-v">{{ result.proposal.repoName }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">提案 id</span><span class="meta-v mono">{{ result.proposal.proposalId }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">校验于</span><span class="meta-v">{{ result.proposal.validatedAt }}</span>
        </div>
        <div class="meta-files">
          <span class="meta-k">涉及文件（{{ result.proposal.files.length }}）</span>
          <ul>
            <li v-for="f in result.proposal.files" :key="f.file">
              <span class="mono">{{ f.file }}</span>
              <span class="baseline" title="基线哈希（应用前会校验文件未变）">基线 {{ f.baselineSha256.slice(0, 12) }}…</span>
              <span class="reason" v-if="f.reason">{{ f.reason }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="diff-card">
        <div class="diff-head">
          <span>统一 diff</span>
          <button class="copy-btn" @click="copyDiff">{{ copied ? '已复制' : '复制' }}</button>
        </div>
        <div class="diff-body">
          <div v-for="(l, i) in diffLines" :key="i" class="dl" :class="l.kind">{{ l.text || ' ' }}</div>
        </div>
      </div>

      <div class="verify-card" v-if="result.proposal.verifyCommands.length">
        <span class="meta-k">建议验证命令</span>
        <pre v-for="(c, i) in result.proposal.verifyCommands" :key="i" class="verify-cmd">$ {{ c }}</pre>
      </div>

      <!-- 审批门：apply / 回滚（唯一写盘入口，需二次确认） -->
      <div class="apply-section">
        <div class="notice error" v-if="applyError">{{ applyError }}</div>

        <template v-if="applyState === 'idle'">
          <button v-if="!confirming" class="apply-btn" @click="confirming = true">应用此提案（落盘到仓库）</button>
          <div v-else class="confirm-box">
            <p>⚠️ 这会<strong>真实修改</strong>仓库中的 {{ result.proposal.files.length }} 个文件。落盘后可一键回滚。</p>
            <div class="confirm-actions">
              <button class="danger-btn" @click="doApply">确认落盘</button>
              <button class="ghost-btn" @click="confirming = false">取消</button>
            </div>
          </div>
        </template>

        <div v-else-if="applyState === 'applying'" class="apply-status"><span class="spinner dark" /> 落盘中...</div>

        <div v-else-if="applyState === 'applied'" class="applied-block">
          <div class="apply-status applied">
            <span>✅ 已落盘到仓库</span>
            <div class="applied-actions">
              <button class="ghost-btn" @click="doVerify" :disabled="verifying">
                <span v-if="verifying" class="spinner dark" />{{ verifying ? '验证中...' : '运行验证' }}
              </button>
              <button class="ghost-btn" @click="doRollback">↩ 回滚</button>
            </div>
          </div>

          <div v-if="verifyResult" class="verify-result" :class="verifyVerdictClass">
            <template v-if="!verifyResult.ran">⚠️ {{ verifyResult.message || '未运行验证（服务端未配置 VERIFY_COMMAND）' }}</template>
            <template v-else>
              <div class="verify-head">
                <strong>{{ verifyResult.passed ? '✅ 验证通过' : verifyResult.timedOut ? '⏱ 验证超时' : '❌ 验证未通过' }}</strong>
                <code v-if="verifyResult.command">$ {{ verifyResult.command }}</code>
              </div>
              <pre v-if="verifyResult.output" class="verify-output">{{ verifyResult.output }}</pre>
            </template>
          </div>
        </div>

        <div v-else-if="applyState === 'rolling'" class="apply-status"><span class="spinner dark" /> 回滚中...</div>

        <div v-else-if="applyState === 'rolled'" class="apply-status rolled">↩ 已回滚到落盘前状态</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import { useCurrentRepo } from '@/composables/useCurrentRepo';
import { useProposePatch } from '@/composables/useProposePatch';

const { currentRepo } = useCurrentRepo();
const { result, loading, error, applyState, applyError, verifying, verifyResult, propose, apply, rollback, verify } = useProposePatch();

const question = ref('');
const fileInput = ref('');
const files = ref<string[]>([]);
const copied = ref(false);
const confirming = ref(false);

function addFile(): void {
  const f = fileInput.value.trim();
  if (f && !files.value.includes(f)) files.value.push(f);
  fileInput.value = '';
}

function handleSubmit(): void {
  if (!question.value.trim() || files.value.length === 0 || loading.value) return;
  confirming.value = false;
  void propose(question.value.trim(), [...files.value]);
}

function currentProposalId(): string {
  const r = result.value;
  return r && r.ok ? r.proposal.proposalId : '';
}

function doApply(): void {
  confirming.value = false;
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

const verifyVerdictClass = computed(() => {
  const v = verifyResult.value;
  if (!v || !v.ran) return 'neutral';
  return v.passed ? 'pass' : 'fail';
});

async function copyDiff(): Promise<void> {
  const r = result.value;
  if (!r || !r.ok) return;
  try {
    await navigator.clipboard.writeText(r.proposal.unifiedDiff);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* 剪贴板不可用时静默 */
  }
}

type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx';
interface DiffLine {
  text: string;
  kind: DiffKind;
}

const diffLines = computed<DiffLine[]>(() => {
  const r = result.value;
  if (!r || !r.ok) return [];
  return r.proposal.unifiedDiff.split('\n').map((line): DiffLine => {
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
});

const FAIL_TEXT: Record<string, string> = {
  PATCH_NOT_APPLICABLE: '未能生成可干净应用的补丁。建议换更精确的目标文件（用问答/prepare_fix_context 重新定位），或把诉求写得更具体。',
  NO_CHANGE: '分析未产生任何改动。可能诉求已满足，或目标文件选得不对。',
  LLM_UNAVAILABLE: 'LLM 不可用。请检查分析服务的 LLM 配置。',
  NO_REPO: '未加载分析仓库。请先在顶部选择一个项目。',
  INVALID_INPUT: '目标文件无效。只允许修改仓库内已存在的文本文件（相对路径）。',
};

const failText = computed(() => {
  const r = result.value;
  if (!r || r.ok) return '';
  return FAIL_TEXT[r.reason] ?? `提案生成失败（${r.reason}）。`;
});
</script>

<style scoped>
.propose {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}

.repo-tag {
  padding: 4px 12px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-surface);
  color: var(--qg-muted);
  font-size: 13px;
  font-weight: 600;
  font-family: var(--qg-font-mono);
}

.subtitle {
  margin-top: 10px;
  color: var(--qg-muted);
  font-size: 14px;
  line-height: 1.6;
}

.subtitle code,
code {
  background: var(--qg-surface);
  padding: 1px 6px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  font-size: 12px;
  color: var(--qg-fg);
  font-family: var(--qg-font-mono);
}

.form-card {
  margin-top: 24px;
  background: var(--qg-elevated);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 24px;
}

.field-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--qg-muted);
  margin-bottom: 8px;
}

.question-input {
  width: 100%;
  background: var(--qg-bg);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 12px 14px;
  font-size: 14px;
  font-family: inherit;
  color: var(--qg-fg);
  resize: vertical;
  margin-bottom: 18px;
  outline: none;
}

.question-input::placeholder,
.file-add::placeholder {
  color: var(--qg-faint);
}

.question-input:focus,
.file-add:focus {
  border-color: var(--qg-focus);
}

.files-input {
  display: flex;
  gap: 8px;
}

.file-add {
  flex: 1;
  background: var(--qg-bg);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 10px 14px;
  font-size: 14px;
  font-family: var(--qg-font-mono);
  color: var(--qg-fg);
  outline: none;
}

.add-btn {
  padding: 0 18px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-surface);
  color: var(--qg-fg);
  font-size: 14px;
  cursor: pointer;
}

.add-btn:hover:not(:disabled) {
  border-color: var(--qg-line-strong);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 12px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-surface);
  color: var(--qg-fg);
  font-size: 12px;
  font-family: var(--qg-font-mono);
}

.chip-x {
  width: 18px;
  height: 18px;
  border-radius: 2px;
  border: none;
  background: transparent;
  color: var(--qg-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}

.chip-x:hover:not(:disabled) {
  color: var(--qg-danger);
}

.submit-btn {
  margin-top: 22px;
  width: 100%;
  height: 46px;
  border-radius: 2px;
  border: none;
  background: var(--qg-fg);
  color: var(--qg-bg);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  transition: background var(--qg-duration), opacity var(--qg-duration);
}

.submit-btn:hover:not(:disabled) {
  opacity: 0.88;
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, var(--qg-bg) 30%, transparent);
  border-top-color: var(--qg-bg);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.notice {
  margin-top: 20px;
  padding: 16px 20px;
  border-radius: 2px;
  font-size: 14px;
  line-height: 1.6;
}

.notice.error {
  background: color-mix(in srgb, var(--qg-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--qg-danger) 40%, transparent);
  color: var(--qg-danger);
}

.notice.warn {
  background: color-mix(in srgb, var(--qg-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--qg-warning) 40%, transparent);
  color: var(--qg-warning);
}

.notice .detail {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.75;
}

.banner {
  margin-top: 24px;
  padding: 14px 18px;
  border-radius: 2px;
  background: var(--qg-surface);
  border: 1px solid var(--qg-line);
  color: var(--qg-fg);
  font-size: 13px;
  line-height: 1.6;
}

.banner .sep {
  margin: 0 8px;
  opacity: 0.5;
}

.banner code {
  background: var(--qg-elevated);
}

.meta-card {
  margin-top: 16px;
  background: var(--qg-elevated);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 18px 20px;
}

.meta-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}

.meta-k {
  color: var(--qg-muted);
  min-width: 92px;
  font-weight: 600;
}

.meta-v {
  color: var(--qg-fg);
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--qg-font-mono);
  overflow-wrap: anywhere;
}

.meta-files {
  margin-top: 8px;
  font-size: 13px;
}

.meta-files ul {
  margin-top: 8px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-files li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.baseline {
  font-size: 11px;
  color: var(--qg-faint);
  background: var(--qg-surface);
  border: 1px solid var(--qg-line);
  padding: 1px 8px;
  border-radius: 2px;
}

.reason {
  font-size: 12px;
  color: var(--qg-muted);
}

.diff-card {
  margin-top: 16px;
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  overflow: hidden;
}

.diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--qg-surface);
  border-bottom: 1px solid var(--qg-line);
  font-size: 13px;
  font-weight: 600;
  color: var(--qg-muted);
}

.copy-btn {
  border: 1px solid var(--qg-line);
  background: var(--qg-elevated);
  border-radius: 2px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--qg-muted);
  cursor: pointer;
}

.copy-btn:hover {
  border-color: var(--qg-line-strong);
  color: var(--qg-fg);
}

.diff-body {
  overflow-x: auto;
  background: var(--qg-elevated);
  padding: 8px 0;
  font-family: var(--qg-font-mono);
  font-size: 12.5px;
  line-height: 1.55;
}

.dl {
  padding: 0 16px;
  white-space: pre;
}

.dl.add {
  color: var(--qg-success);
  background: color-mix(in srgb, var(--qg-success) 12%, transparent);
}

.dl.del {
  color: var(--qg-danger);
  background: color-mix(in srgb, var(--qg-danger) 12%, transparent);
}

.dl.hunk {
  color: var(--qg-muted);
  background: var(--qg-surface);
}

.dl.meta {
  color: var(--qg-faint);
}

.dl.ctx {
  color: var(--qg-fg);
}

.verify-card {
  margin-top: 16px;
  background: var(--qg-elevated);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 16px 20px;
  font-size: 13px;
}

.verify-cmd {
  margin-top: 8px;
  background: var(--qg-surface);
  color: var(--qg-fg);
  border: 1px solid var(--qg-line);
  padding: 8px 14px;
  border-radius: 2px;
  font-family: var(--qg-font-mono);
  font-size: 12.5px;
  overflow-x: auto;
}

.apply-section {
  margin-top: 20px;
}

.apply-btn {
  width: 100%;
  height: 44px;
  border-radius: 2px;
  border: 1px solid var(--qg-fg);
  background: var(--qg-fg);
  color: var(--qg-bg);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--qg-duration);
}

.apply-btn:hover {
  opacity: 0.88;
}

.confirm-box {
  border: 1px solid color-mix(in srgb, var(--qg-warning) 40%, transparent);
  background: color-mix(in srgb, var(--qg-warning) 12%, transparent);
  border-radius: 2px;
  padding: 16px 20px;
}

.confirm-box p {
  font-size: 14px;
  color: var(--qg-warning);
  line-height: 1.6;
}

.confirm-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}

.danger-btn {
  padding: 9px 22px;
  border-radius: 2px;
  border: none;
  background: var(--qg-danger);
  color: var(--qg-bg);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.danger-btn:hover {
  opacity: 0.88;
}

.ghost-btn {
  padding: 9px 18px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-elevated);
  color: var(--qg-fg);
  font-size: 14px;
  cursor: pointer;
}

.ghost-btn:hover {
  border-color: var(--qg-line-strong);
  color: var(--qg-fg);
}

.apply-status {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  background: var(--qg-surface);
  color: var(--qg-muted);
  font-size: 14px;
  font-weight: 600;
}

.apply-status.applied {
  background: color-mix(in srgb, var(--qg-success) 10%, transparent);
  border-color: color-mix(in srgb, var(--qg-success) 40%, transparent);
  color: var(--qg-success);
  justify-content: space-between;
}

.apply-status.rolled {
  background: var(--qg-surface);
  color: var(--qg-muted);
}

.spinner.dark {
  border: 2px solid color-mix(in srgb, var(--qg-fg) 25%, transparent);
  border-top-color: var(--qg-fg);
}

.applied-block {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.applied-actions {
  display: flex;
  gap: 10px;
}

.applied-actions .ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.verify-result {
  border-radius: 2px;
  border: 1px solid var(--qg-line);
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.6;
}

.verify-result.pass {
  background: color-mix(in srgb, var(--qg-success) 10%, transparent);
  border-color: color-mix(in srgb, var(--qg-success) 40%, transparent);
  color: var(--qg-success);
}

.verify-result.fail {
  background: color-mix(in srgb, var(--qg-danger) 10%, transparent);
  border-color: color-mix(in srgb, var(--qg-danger) 40%, transparent);
  color: var(--qg-danger);
}

.verify-result.neutral {
  background: color-mix(in srgb, var(--qg-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--qg-warning) 40%, transparent);
  color: var(--qg-warning);
}

.verify-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.verify-head code {
  background: var(--qg-surface);
  color: inherit;
  padding: 2px 8px;
  border-radius: 2px;
  font-size: 12px;
}

.verify-output {
  margin-top: 10px;
  max-height: 320px;
  overflow: auto;
  background: var(--qg-surface);
  color: var(--qg-fg);
  border: 1px solid var(--qg-line);
  padding: 12px 14px;
  border-radius: 2px;
  font-family: var(--qg-font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
