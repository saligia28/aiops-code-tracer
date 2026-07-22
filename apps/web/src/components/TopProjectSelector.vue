<template>
  <div ref="floatingRef" class="project-floating" :class="{ 'is-expanded': expanded }">
    <button
      class="project-trigger"
      :class="{ 'is-active': expanded, 'is-loading': loading }"
      type="button"
      aria-controls="project-selector-panel"
      :aria-expanded="expanded"
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

    <div v-if="expanded" id="project-selector-panel" class="project-panel">
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

    <!-- 新建 / 删除项目弹窗（目录浏览器嵌在新建弹窗内） -->
    <ProjectCreateDialog v-model="dialogVisible" />
    <ProjectDeleteDialog v-model="deleteDialogVisible" :target="deleteTarget" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/lib/http';
import { useProject, frameworkLabel } from '@/composables/useProject';
import ProjectCreateDialog from './ProjectCreateDialog.vue';
import ProjectDeleteDialog from './ProjectDeleteDialog.vue';
import '@/styles/glass-dialog.css';

const {
  currentProjectId,
  currentProjectName,
  projects,
  loading,
  fetchProjects,
  switchProject,
  buildProject,
} = useProject();

const expanded = ref(false);
const dialogVisible = ref(false);
const buildingId = ref<string | null>(null);
const floatingRef = ref<HTMLElement | null>(null);

// ---- 删除确认（关联风险在打开前查询并填入 deleteTarget，弹窗本体见 ProjectDeleteDialog） ----
const deleteDialogVisible = ref(false);
const deleteTarget = reactive({
  id: '',
  name: '',
  risks: [] as string[],
});

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

// ---- 删除流程：先查关联风险，再打开确认弹窗 ----
async function handleDeleteCheck(id: string, name: string) {
  deleteTarget.id = id;
  deleteTarget.name = name;
  deleteTarget.risks = [];

  try {
    const res = await http.get<{ risks: string[] }>(`/api/projects/${id}/relations`);
    deleteTarget.risks = res.data.risks;
  } catch {
    // 查询失败也允许继续删除
  }

  deleteDialogVisible.value = true;
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
  position: relative;
  z-index: 1200;
  display: flex;
  align-items: flex-end;
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
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
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
    position: fixed;
    bottom: calc(140px + env(safe-area-inset-bottom, 0px));
    right: 16px;
    left: auto;
    z-index: 1200;
    display: flex;
    flex-direction: column-reverse;
    align-items: flex-end;
    gap: 8px;
  }

  .project-floating.is-expanded {
    z-index: 1210;
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
    position: static;
    top: auto;
    right: auto;
    width: min(300px, calc(100vw - 32px));
    max-width: none;
    margin-bottom: 8px;
  }
}
</style>
