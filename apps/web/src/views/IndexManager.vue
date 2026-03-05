<template>
  <div class="index-manager">
    <el-page-header @back="$router.push('/')">
      <template #content>索引管理</template>
    </el-page-header>

    <el-card class="status-card">
      <template #header>索引状态</template>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="状态">
          <el-tag :type="statusTag">{{ status.status }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="仓库">{{ status.repoName || '--' }}</el-descriptions-item>
        <el-descriptions-item label="文件数">{{ status.totalFiles || '--' }}</el-descriptions-item>
        <el-descriptions-item label="节点数">{{ status.totalNodes || '--' }}</el-descriptions-item>
        <el-descriptions-item label="边数">{{ status.totalEdges || '--' }}</el-descriptions-item>
        <el-descriptions-item label="最近构建">{{ status.lastBuildTime || '--' }}</el-descriptions-item>
        <el-descriptions-item label="阶段">{{ status.phase || '--' }}</el-descriptions-item>
        <el-descriptions-item label="信息">{{ status.message || '--' }}</el-descriptions-item>
      </el-descriptions>
    </el-card>

    <div class="actions">
      <el-button type="primary" @click="triggerBuild" :loading="building">全量构建</el-button>
      <el-button @click="triggerRebuild" :loading="building">增量重建</el-button>
    </div>

    <el-card v-if="building" class="progress-card">
      <template #header>构建进度</template>
      <el-progress :percentage="progress" :status="progress === 100 ? 'success' : undefined" />
      <p class="progress-text">{{ status.message || '处理中...' }}</p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import axios from 'axios';

const status = ref<any>({});
const building = ref(false);
const progress = ref(0);
const ws = ref<WebSocket | null>(null);

const statusTag = computed(() => {
  const s = status.value.status;
  if (s === 'ready') return 'success';
  if (s === 'building') return 'warning';
  if (s === 'error') return 'danger';
  return 'info';
});

async function refreshStatus() {
  try {
    const res = await axios.get('/api/index/status');
    status.value = res.data;
    if (status.value.status === 'building') {
      building.value = true;
      progress.value = Number(status.value.progress) || 0;
    } else {
      building.value = false;
      if (typeof status.value.progress === 'number') {
        progress.value = status.value.progress;
      }
    }
  } catch {
    // ignore
  }
}

function connectProgressWs() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}/ws/progress`;
  const socket = new WebSocket(wsUrl);
  ws.value = socket;

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type !== 'index-progress') return;
      status.value = {
        ...status.value,
        status: payload.status,
        repoName: payload.repoName ?? status.value.repoName,
        progress: payload.progress,
        phase: payload.phase,
        message: payload.message,
        error: payload.error,
      };
      progress.value = Number(payload.progress) || 0;
      building.value = payload.status === 'building';
      if (payload.status === 'ready' || payload.status === 'error') {
        void refreshStatus();
      }
    } catch {
      // ignore invalid message
    }
  };
}

onMounted(async () => {
  await refreshStatus();
  connectProgressWs();
});

onBeforeUnmount(() => {
  if (ws.value) {
    ws.value.close();
    ws.value = null;
  }
});

async function triggerBuild() {
  try {
    const res = await axios.post('/api/index/build');
    if (res.data?.status === 'building') {
      building.value = true;
      progress.value = 0;
      status.value = { ...status.value, status: 'building', message: res.data.message, repoName: res.data.repoName };
    }
    await refreshStatus();
  } catch {
    // ignore
  }
}

async function triggerRebuild() {
  try {
    const res = await axios.post('/api/index/rebuild');
    if (res.data?.status === 'building') {
      building.value = true;
      progress.value = 0;
      status.value = { ...status.value, status: 'building', message: res.data.message, repoName: res.data.repoName };
    }
    await refreshStatus();
  } catch {
    // ignore
  }
}
</script>

<style scoped>
.index-manager {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 20px;
}

.status-card {
  margin: 20px 0;
}

.actions {
  margin-bottom: 20px;
}

.progress-card {
  margin-bottom: 20px;
}

.progress-text {
  margin-top: 12px;
  color: #606266;
  font-size: 13px;
}
</style>
