<template>
  <div ref="floatingRef" class="project-floating" :class="{ 'is-expanded': expanded }">
    <button
      class="project-trigger"
      :class="{ 'is-active': expanded, 'is-loading': loading }"
      type="button"
      @click="toggleExpanded"
    >
      <span class="trigger-dot" />
      <span class="mobile-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M3 6a2 2 0 012-2h2.586a1 1 0 01.707.293l1.414 1.414A1 1 0 0010.414 6H15a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V6z"/>
        </svg>
      </span>
      <span class="trigger-body">
        <span class="trigger-label">{{ currentProjectName || '未选择项目' }}</span>
        <span class="trigger-badge">{{ projects.length }} 项目</span>
      </span>
    </button>

    <div v-if="expanded" class="project-panel">
      <div class="panel-header">
        <div class="panel-title">项目切换</div>
        <button class="panel-close" type="button" @click="expanded = false">收起</button>
      </div>

      <div v-if="loading" class="panel-status">正在加载...</div>

      <div v-else-if="projects.length === 0" class="panel-status">
        暂无项目，点击下方按钮创建
      </div>

      <div v-else class="project-list">
        <div
          v-for="p in projects"
          :key="p.id"
          class="project-item"
          :class="{ active: p.id === currentProjectId }"
        >
          <button class="project-main" type="button" @click="handleSwitch(p.id)">
            <span class="project-info">
              <span class="project-name">{{ p.name }}</span>
              <span class="project-fw">{{ frameworkLabel(p.framework) }}</span>
            </span>
            <span class="project-meta" v-if="p.hasGraph">
              {{ p.totalNodes ?? '-' }} 符号
            </span>
            <span class="project-meta no-graph" v-else>未构建</span>
          </button>
          <button
            class="project-build-btn"
            :class="{ building: buildingId === p.id }"
            type="button"
            :title="p.hasGraph ? '重新构建图谱' : '构建图谱'"
            :disabled="buildingId === p.id"
            @click.stop="handleBuild(p.id, p.name)"
          >
            {{ buildingId === p.id ? '构建中' : '构建' }}
          </button>
          <button
            class="project-delete-btn"
            type="button"
            title="删除项目"
            @click.stop="handleDeleteCheck(p.id, p.name)"
          >
            &times;
          </button>
        </div>
      </div>

      <button class="new-project-btn" type="button" @click="dialogVisible = true">
        + 新建项目
      </button>
    </div>

    <!-- 新建项目弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      width="460px"
      :close-on-click-modal="false"
      :show-close="false"
      custom-class="glass-dialog"
    >
      <template #header>
        <div class="glass-dialog-header">
          <span class="glass-dialog-title">新建项目</span>
          <button class="glass-dialog-close" type="button" @click="dialogVisible = false">&times;</button>
        </div>
      </template>

      <div class="glass-form">
        <label class="glass-label">
          <span class="glass-label-text">项目名称 <em>*</em></span>
          <input v-model="form.name" class="glass-input" placeholder="例如 my-project" />
        </label>
        <label class="glass-label">
          <span class="glass-label-text">语言 / 框架 <em>*</em></span>
          <select v-model="form.framework" class="glass-input glass-select">
            <option v-for="opt in frameworkOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <label class="glass-label">
          <span class="glass-label-text">仓库路径 <em>*</em></span>
          <div class="glass-input-row">
            <input
              :value="form.repoPath"
              class="glass-input"
              placeholder="/Users/.../your-project"
              readonly
              @click="openBrowser"
            />
            <button class="glass-btn-outline" type="button" @click="openBrowser">浏览</button>
          </div>
        </label>
        <label class="glass-label">
          <span class="glass-label-text">Git 地址 <span class="glass-label-hint">(预留)</span></span>
          <input v-model="form.gitUrl" class="glass-input" placeholder="https://github.com/..." />
        </label>
        <label class="glass-label">
          <span class="glass-label-text">扫描路径</span>
          <input v-model="form.scanPathsStr" class="glass-input" placeholder="src（多个用逗号分隔）" />
        </label>
      </div>

      <template #footer>
        <div class="glass-dialog-footer">
          <button class="glass-btn glass-btn-ghost" type="button" @click="dialogVisible = false">取消</button>
          <button class="glass-btn glass-btn-primary" type="button" :disabled="creating" @click="handleCreate">
            {{ creating ? '创建中...' : '确认创建' }}
          </button>
        </div>
      </template>
    </el-dialog>

    <!-- 删除确认弹窗 -->
    <el-dialog
      v-model="deleteDialogVisible"
      width="420px"
      :close-on-click-modal="false"
      :show-close="false"
      append-to-body
      custom-class="glass-dialog glass-dialog-danger"
    >
      <template #header>
        <div class="glass-dialog-header">
          <span class="glass-dialog-title">删除项目</span>
          <button class="glass-dialog-close" type="button" @click="deleteDialogVisible = false">&times;</button>
        </div>
      </template>

      <p class="glass-dialog-body-text">
        确定要删除项目「<strong>{{ deleteTarget.name }}</strong>」吗？
      </p>
      <div v-if="deleteTarget.risks.length > 0" class="delete-risks">
        <div class="risk-title">风险提示</div>
        <ul class="risk-list">
          <li v-for="(r, i) in deleteTarget.risks" :key="i">{{ r }}</li>
        </ul>
      </div>
      <label class="glass-checkbox">
        <input type="checkbox" v-model="deleteTarget.deleteData" />
        <span>同时删除图谱数据（不可恢复）</span>
      </label>

      <template #footer>
        <div class="glass-dialog-footer">
          <button class="glass-btn glass-btn-ghost" type="button" @click="deleteDialogVisible = false">取消</button>
          <button class="glass-btn glass-btn-danger" type="button" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中...' : '确认删除' }}
          </button>
        </div>
      </template>
    </el-dialog>

    <!-- 目录浏览弹窗 -->
    <el-dialog
      v-model="browserVisible"
      width="520px"
      :close-on-click-modal="false"
      :show-close="false"
      append-to-body
      custom-class="glass-dialog"
    >
      <template #header>
        <div class="glass-dialog-header">
          <span class="glass-dialog-title">选择仓库目录</span>
          <button class="glass-dialog-close" type="button" @click="browserVisible = false">&times;</button>
        </div>
      </template>

      <!-- 当前路径面包屑 -->
      <div class="browser-breadcrumb">
        <button
          v-for="(seg, i) in pathSegments"
          :key="i"
          class="breadcrumb-seg"
          type="button"
          @click="navigateTo(seg.path)"
        >
          {{ seg.label }}
        </button>
      </div>

      <!-- 项目标记 -->
      <div v-if="browserInfo.isGitRepo || browserInfo.hasPackageJson" class="browser-badges">
        <span v-if="browserInfo.isGitRepo" class="browser-badge git">Git</span>
        <span v-if="browserInfo.hasPackageJson" class="browser-badge pkg">package.json</span>
      </div>

      <!-- 目录列表 -->
      <div class="browser-list" :class="{ 'is-loading': browserLoading }">
        <div v-if="browserLoading" class="browser-empty">加载中...</div>
        <template v-else>
          <button
            v-if="browserInfo.parent"
            class="browser-item parent"
            type="button"
            @click="navigateTo(browserInfo.parent)"
          >
            ..
          </button>
          <button
            v-for="dir in browserInfo.dirs"
            :key="dir"
            class="browser-item"
            type="button"
            @click="navigateTo(browserInfo.current + '/' + dir)"
          >
            <span class="dir-icon">📁</span>
            <span class="dir-name">{{ dir }}</span>
          </button>
          <div v-if="browserInfo.dirs.length === 0" class="browser-empty">
            无子目录
          </div>
        </template>
      </div>

      <template #footer>
        <div class="glass-dialog-footer browser-footer">
          <span class="browser-selected" :title="browserInfo.current">{{ browserInfo.current }}</span>
          <div class="browser-actions">
            <button class="glass-btn glass-btn-ghost" type="button" @click="browserVisible = false">取消</button>
            <button class="glass-btn glass-btn-primary" type="button" @click="confirmBrowser">选择此目录</button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, reactive, computed } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/lib/http';
import { useProject } from '@/composables/useProject';
import type { ProjectFramework } from '@/composables/useProject';

const {
  currentProjectId,
  currentProjectName,
  projects,
  loading,
  fetchProjects,
  switchProject,
  createProject,
  buildProject,
  deleteProject,
} = useProject();

const expanded = ref(false);
const dialogVisible = ref(false);
const creating = ref(false);
const buildingId = ref<string | null>(null);
const floatingRef = ref<HTMLElement | null>(null);

// ---- 删除确认 ----
const deleteDialogVisible = ref(false);
const deleting = ref(false);
const deleteTarget = reactive({
  id: '',
  name: '',
  risks: [] as string[],
  deleteData: false,
});

// ---- 目录浏览器 ----
const browserVisible = ref(false);
const browserLoading = ref(false);

interface BrowserInfo {
  current: string;
  parent: string | null;
  dirs: string[];
  isGitRepo: boolean;
  hasPackageJson: boolean;
}

const browserInfo = reactive<BrowserInfo>({
  current: '',
  parent: null,
  dirs: [],
  isGitRepo: false,
  hasPackageJson: false,
});

const pathSegments = computed(() => {
  if (!browserInfo.current) return [];
  const parts = browserInfo.current.split('/').filter(Boolean);
  const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    segs.push({ label: part, path: acc });
  }
  return segs;
});

async function fetchDirs(dirPath: string) {
  browserLoading.value = true;
  try {
    const res = await http.get<BrowserInfo>('/api/fs/dirs', { params: { path: dirPath } });
    browserInfo.current = res.data.current;
    browserInfo.parent = res.data.parent;
    browserInfo.dirs = res.data.dirs;
    browserInfo.isGitRepo = res.data.isGitRepo;
    browserInfo.hasPackageJson = res.data.hasPackageJson;
  } catch {
    ElMessage.error('读取目录失败');
  } finally {
    browserLoading.value = false;
  }
}

function navigateTo(dirPath: string) {
  void fetchDirs(dirPath);
}

function openBrowser() {
  browserVisible.value = true;
  void fetchDirs(form.repoPath || '');
}

function confirmBrowser() {
  form.repoPath = browserInfo.current;
  browserVisible.value = false;
}

// ---- 项目表单 ----
const frameworkOptions: { value: ProjectFramework; label: string }[] = [
  { value: 'vue3', label: 'Vue 3' },
  { value: 'vue2', label: 'Vue 2' },
  { value: 'react', label: 'React' },
  { value: 'nextjs', label: 'Next.js' },
  { value: 'angular', label: 'Angular' },
  { value: 'svelte', label: 'Svelte' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'java', label: 'Java' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'other', label: '其他' },
];

const form = reactive({
  name: '',
  framework: 'vue3' as ProjectFramework,
  repoPath: '',
  gitUrl: '',
  scanPathsStr: 'src',
});

function frameworkLabel(fw: string): string {
  return frameworkOptions.find((o) => o.value === fw)?.label ?? fw;
}

function toggleExpanded() {
  const next = !expanded.value;
  expanded.value = next;
  if (next) {
    window.dispatchEvent(new CustomEvent('floating-panel-open', { detail: 'project' }));
  }
}

function handlePanelOpen(event: Event) {
  const customEvent = event as CustomEvent<string>;
  if (customEvent.detail !== 'project') {
    expanded.value = false;
  }
}

function handleClickOutside(event: Event) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (floatingRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.glass-dialog')) return;
  expanded.value = false;
}

async function handleSwitch(id: string) {
  if (id === currentProjectId.value) {
    expanded.value = false;
    return;
  }
  try {
    await switchProject(id);
    const name = projects.value.find((p) => p.id === id)?.name ?? id;
    ElMessage.success(`已切换到 ${name}`);
    expanded.value = false;
  } catch {
    ElMessage.error('切换项目失败');
  }
}

async function handleBuild(id: string, name: string) {
  buildingId.value = id;
  try {
    await buildProject(id);
    ElMessage.info(`"${name}" 构建任务已提交，完成后自动刷新`);
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '构建失败';
    ElMessage.error(msg);
    buildingId.value = null;
  }
}

// ---- WebSocket 监听构建进度 ----
let progressWs: WebSocket | null = null;

function connectProgressWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/progress`);

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as { type?: string; status?: string; phase?: string };
      if (data.type !== 'index-progress') return;

      if (data.status === 'ready' || data.status === 'error') {
        // 仅在用户主动触发构建时才弹提示，避免服务初始化/重连时误弹
        if (buildingId.value) {
          if (data.status === 'ready') {
            ElMessage.success('图谱构建完成');
          } else {
            ElMessage.error('图谱构建失败');
          }
        }
        buildingId.value = null;
        void fetchProjects();
      }
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    setTimeout(() => {
      if (progressWs === ws) connectProgressWs();
    }, 3000);
  };

  progressWs = ws;
}

// ---- 删除流程 ----
async function handleDeleteCheck(id: string, name: string) {
  deleteTarget.id = id;
  deleteTarget.name = name;
  deleteTarget.risks = [];
  deleteTarget.deleteData = false;

  try {
    const res = await http.get<{ risks: string[] }>(`/api/projects/${id}/relations`);
    deleteTarget.risks = res.data.risks;
  } catch {
    // 查询失败也允许继续删除
  }

  deleteDialogVisible.value = true;
}

async function confirmDelete() {
  deleting.value = true;
  try {
    await deleteProject(deleteTarget.id, deleteTarget.deleteData);
    ElMessage.success(`项目「${deleteTarget.name}」已删除`);
    deleteDialogVisible.value = false;
  } catch {
    ElMessage.error('删除失败');
  } finally {
    deleting.value = false;
  }
}

function resetForm() {
  form.name = '';
  form.framework = 'vue3';
  form.repoPath = '';
  form.gitUrl = '';
  form.scanPathsStr = 'src';
}

async function handleCreate() {
  if (!form.name.trim()) {
    ElMessage.warning('请输入项目名称');
    return;
  }
  if (!form.repoPath.trim()) {
    ElMessage.warning('请选择本地仓库路径');
    return;
  }

  creating.value = true;
  try {
    const scanPaths = form.scanPathsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const record = await createProject({
      name: form.name.trim(),
      framework: form.framework,
      repoPath: form.repoPath.trim(),
      gitUrl: form.gitUrl.trim(),
      scanPaths: scanPaths.length > 0 ? scanPaths : ['src'],
    });

    ElMessage.success(`项目 "${record.name}" 创建成功`);
    dialogVisible.value = false;
    resetForm();

    await switchProject(record.id);
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '创建失败';
    ElMessage.error(msg);
  } finally {
    creating.value = false;
  }
}

onMounted(() => {
  window.addEventListener('floating-panel-open', handlePanelOpen as EventListener);
  document.addEventListener('pointerdown', handleClickOutside);
  void fetchProjects();
  connectProgressWs();
});

onUnmounted(() => {
  window.removeEventListener('floating-panel-open', handlePanelOpen as EventListener);
  document.removeEventListener('pointerdown', handleClickOutside);
  if (progressWs) {
    const ws = progressWs;
    progressWs = null;
    ws.close();
  }
});
</script>

<!-- scoped 样式：浮窗 + 面板 -->
<style scoped>
.project-floating {
  position: fixed;
  bottom: 80px;
  left: 16px;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-start;
  gap: 8px;
}

.project-floating.is-expanded {
  z-index: 1210;
}

/* ---- 移动端图标（桌面隐藏）---- */
.mobile-icon {
  display: none;
  align-items: center;
  justify-content: center;
  color: #4f6ef7;
}

/* ---- 触发按钮 ---- */
.project-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 120px;
  max-width: 260px;
  padding: 8px 14px;
  border: 1.5px solid rgba(224, 228, 238, 0.9);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(12px);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.project-trigger:hover {
  border-color: rgba(79, 110, 247, 0.5);
}

.project-trigger.is-active {
  border-color: rgba(79, 110, 247, 0.75);
  box-shadow: 0 4px 20px rgba(15, 23, 42, 0.10);
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}

.trigger-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4f6ef7;
}

.is-loading .trigger-dot {
  background: #909399;
  animation: dot-pulse 1s ease-in-out infinite;
}

.trigger-body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.trigger-label {
  font-size: 12.5px;
  font-weight: 600;
  color: #2b2f3a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trigger-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2.5px 6px;
  border-radius: 4px;
  background: rgba(79, 110, 247, 0.1);
  color: #4f6ef7;
}

/* ---- 展开面板 ---- */
.project-panel {
  width: 300px;
  padding: 14px;
  border: 1.5px solid rgba(79, 110, 247, 0.3);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 12px 36px rgba(15, 23, 42, 0.10);
  backdrop-filter: blur(12px);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-title {
  font-size: 13px;
  font-weight: 700;
  color: #2b2f3a;
}

.panel-close {
  border: none;
  background: transparent;
  color: #7a8197;
  cursor: pointer;
  font-size: 12px;
  transition: color 0.2s;
}

.panel-close:hover {
  color: #4f6ef7;
}

.panel-status {
  font-size: 12px;
  color: #909399;
  line-height: 1.5;
}

/* ---- 项目列表 ---- */
.project-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow-y: auto;
}

.project-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  transition: all 0.15s;
}

.project-item:hover {
  background: #f4f5f9;
}

.project-item.active {
  background: rgba(79, 110, 247, 0.08);
  border-color: rgba(79, 110, 247, 0.25);
}

.project-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.project-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.project-name {
  font-size: 13px;
  font-weight: 500;
  color: #2b2f3a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-item.active .project-name {
  color: #4f6ef7;
  font-weight: 600;
}

.project-fw {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
  background: rgba(103, 194, 58, 0.12);
  color: #67c23a;
}

.project-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: #909399;
}

.project-meta.no-graph {
  color: #c0c4cc;
}

.project-build-btn {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid rgba(230, 162, 60, 0.4);
  border-radius: 4px;
  background: rgba(230, 162, 60, 0.08);
  color: #e6a23c;
  font-size: 10.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.project-build-btn:hover:not(:disabled) {
  background: rgba(230, 162, 60, 0.18);
  border-color: rgba(230, 162, 60, 0.6);
}

.project-build-btn.building {
  color: #909399;
  border-color: #dcdfe6;
  background: #f5f7fa;
  cursor: not-allowed;
}

.project-delete-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #c0c4cc;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}

.project-delete-btn:hover {
  background: rgba(245, 108, 108, 0.1);
  color: #f56c6c;
}

.new-project-btn {
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px 0;
  border: 1.5px dashed rgba(79, 110, 247, 0.35);
  border-radius: 8px;
  background: transparent;
  color: #4f6ef7;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.new-project-btn:hover {
  background: rgba(79, 110, 247, 0.06);
  border-color: rgba(79, 110, 247, 0.6);
}

@media (max-width: 768px) {
  .project-floating {
    bottom: calc(140px + env(safe-area-inset-bottom, 0px));
    right: 16px;
    left: auto;
    align-items: flex-end;
  }

  /* 触发按钮变圆形 */
  .project-trigger {
    width: 44px;
    height: 44px;
    min-width: 44px;
    max-width: 44px;
    border-radius: 50%;
    padding: 0;
    justify-content: center;
    position: relative;
  }

  /* 文字标签隐藏，图标显示 */
  .trigger-body {
    display: none;
  }

  .mobile-icon {
    display: flex;
  }

  /* 移动端隐藏状态圆点，状态由边框体现 */
  .trigger-dot {
    display: none;
  }

  /* 面板从右侧弹出，宽度自适应 */
  .project-panel {
    width: min(300px, calc(100vw - 32px));
    max-width: none;
    margin-bottom: 8px;
  }
}
</style>

<!-- 非 scoped：el-dialog 渲染到 body，需要全局覆盖 -->
<style>
/* ====== Glass Dialog 主题 ====== */
@keyframes glass-breathe {
  0%, 100% { border-color: rgba(79, 110, 247, 0.2); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.10), 0 0 0 0 rgba(79, 110, 247, 0); }
  50%      { border-color: rgba(79, 110, 247, 0.45); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.10), 0 0 16px 2px rgba(79, 110, 247, 0.08); }
}

@keyframes glass-breathe-danger {
  0%, 100% { border-color: rgba(245, 108, 108, 0.2); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.10), 0 0 0 0 rgba(245, 108, 108, 0); }
  50%      { border-color: rgba(245, 108, 108, 0.45); box-shadow: 0 20px 60px rgba(15, 23, 42, 0.10), 0 0 16px 2px rgba(245, 108, 108, 0.08); }
}

.glass-dialog.el-dialog {
  border-radius: 16px;
  border: 1.5px solid rgba(79, 110, 247, 0.2);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(20px);
  overflow: hidden;
  animation: glass-breathe 3s ease-in-out infinite;
}

.glass-dialog.glass-dialog-danger.el-dialog {
  animation: glass-breathe-danger 3s ease-in-out infinite;
}

.glass-dialog .el-dialog__header {
  padding: 0;
  margin: 0;
}

.glass-dialog .el-dialog__body {
  padding: 0 28px 20px;
  color: #2b2f3a;
}

.glass-dialog .el-dialog__footer {
  padding: 4px 28px 24px;
}

/* ---- header ---- */
.glass-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 28px 16px;
}

.glass-dialog-title {
  font-size: 15px;
  font-weight: 700;
  color: #1a1d26;
  letter-spacing: -0.01em;
}

.glass-dialog-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid transparent;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  color: #909399;
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}

.glass-dialog-close:hover {
  background: rgba(0, 0, 0, 0.06);
  border-color: #e0e4ee;
  color: #2b2f3a;
}

/* ---- footer ---- */
.glass-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

/* ---- 通用 glass 按钮 ---- */
.glass-btn {
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  border: 1.5px solid transparent;
  line-height: 1.4;
}

.glass-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.glass-btn-primary {
  background: #4f6ef7;
  color: #fff;
  border-color: #4f6ef7;
}

.glass-btn-primary:hover:not(:disabled) {
  background: #3d5bdf;
  border-color: #3d5bdf;
}

.glass-btn-danger {
  background: #f56c6c;
  color: #fff;
  border-color: #f56c6c;
}

.glass-btn-danger:hover:not(:disabled) {
  background: #e04848;
  border-color: #e04848;
}

.glass-btn-ghost {
  background: transparent;
  color: #606266;
  border-color: #dcdfe6;
}

.glass-btn-ghost:hover:not(:disabled) {
  color: #4f6ef7;
  border-color: rgba(79, 110, 247, 0.4);
  background: rgba(79, 110, 247, 0.04);
}

.glass-btn-outline {
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  background: transparent;
  color: #4f6ef7;
  border: 1.5px solid rgba(79, 110, 247, 0.4);
  transition: all 0.15s;
  white-space: nowrap;
}

.glass-btn-outline:hover {
  background: rgba(79, 110, 247, 0.06);
  border-color: #4f6ef7;
}

/* ---- glass 表单 ---- */
.glass-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.glass-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.glass-label-text {
  font-size: 12.5px;
  font-weight: 600;
  color: #4a4e5a;
}

.glass-label-text em {
  color: #f56c6c;
  font-style: normal;
}

.glass-label-hint {
  font-weight: 400;
  color: #b0b4c0;
}

.glass-input {
  width: 100%;
  padding: 9px 12px;
  border: 1.5px solid #e0e4ee;
  border-radius: 8px;
  background: rgba(245, 247, 250, 0.6);
  font-size: 13px;
  color: #2b2f3a;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
  box-sizing: border-box;
}

.glass-input::placeholder {
  color: #b0b4c0;
}

.glass-input:focus {
  border-color: rgba(79, 110, 247, 0.5);
  box-shadow: 0 0 0 3px rgba(79, 110, 247, 0.08);
}

.glass-input[readonly] {
  cursor: pointer;
}

.glass-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%23909399' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}

.glass-input-row {
  display: flex;
  gap: 8px;
}

.glass-input-row .glass-input {
  flex: 1;
}

/* ---- glass checkbox ---- */
.glass-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  cursor: pointer;
  font-size: 12.5px;
  color: #606266;
}

.glass-checkbox input[type="checkbox"] {
  width: 15px;
  height: 15px;
  accent-color: #4f6ef7;
  cursor: pointer;
}

/* ---- body text ---- */
.glass-dialog-body-text {
  font-size: 13.5px;
  color: #2b2f3a;
  line-height: 1.6;
  margin: 0 0 14px;
}

/* ---- 删除风险提示 ---- */
.delete-risks {
  padding: 12px 14px;
  background: rgba(245, 108, 108, 0.05);
  border: 1px solid rgba(245, 108, 108, 0.15);
  border-radius: 10px;
}

.risk-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #e04848;
  margin-bottom: 6px;
}

.risk-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: #606266;
  line-height: 1.8;
}

/* ---- 目录浏览器 ---- */
.browser-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 12px;
  background: rgba(245, 247, 250, 0.8);
  border-radius: 8px;
  min-height: 34px;
}

.breadcrumb-seg {
  border: none;
  background: none;
  color: #4f6ef7;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background 0.15s;
}

.breadcrumb-seg:hover {
  background: rgba(79, 110, 247, 0.1);
}

.breadcrumb-seg::after {
  content: '/';
  color: #c0c4cc;
  margin-left: 2px;
}

.breadcrumb-seg:last-child {
  color: #2b2f3a;
  font-weight: 600;
}

.breadcrumb-seg:last-child::after {
  display: none;
}

.browser-badges {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.browser-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
}

.browser-badge.git {
  background: rgba(245, 108, 108, 0.1);
  color: #f56c6c;
}

.browser-badge.pkg {
  background: rgba(103, 194, 58, 0.1);
  color: #67c23a;
}

.browser-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
  min-height: 120px;
  border: 1.5px solid #e8ebf2;
  border-radius: 10px;
  padding: 6px;
  background: rgba(250, 251, 253, 0.6);
}

.browser-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  color: #2b2f3a;
  transition: background 0.12s;
}

.browser-item:hover {
  background: rgba(79, 110, 247, 0.06);
}

.browser-item.parent {
  color: #909399;
  font-weight: 600;
}

.dir-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.dir-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-empty {
  font-size: 12px;
  color: #c0c4cc;
  text-align: center;
  padding: 24px 0;
}

.browser-footer {
  flex-direction: row;
  justify-content: space-between;
}

.browser-selected {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browser-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

/* ---- 遮罩层 ---- */
.el-overlay {
  backdrop-filter: blur(4px);
  background: rgba(15, 23, 42, 0.22) !important;
}
</style>
