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
      </el-descriptions>
    </el-card>

    <div class="actions">
      <el-button type="primary" @click="triggerBuild" :loading="building">全量构建</el-button>
      <el-button @click="triggerRebuild" :loading="building">增量重建</el-button>
    </div>

    <el-card v-if="building" class="progress-card">
      <template #header>构建进度</template>
      <el-progress :percentage="progress" :status="progress === 100 ? 'success' : undefined" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';

const status = ref<any>({});
const building = ref(false);
const progress = ref(0);

const statusTag = computed(() => {
  const s = status.value.status;
  if (s === 'ready') return 'success';
  if (s === 'building') return 'warning';
  if (s === 'error') return 'danger';
  return 'info';
});

onMounted(async () => {
  try {
    const res = await axios.get('/api/index/status');
    status.value = res.data;
  } catch {
    // ignore
  }
});

async function triggerBuild() {
  building.value = true;
  progress.value = 0;
  try {
    await axios.post('/api/index/build');
    progress.value = 100;
  } finally {
    building.value = false;
  }
}

async function triggerRebuild() {
  building.value = true;
  progress.value = 0;
  try {
    await axios.post('/api/index/rebuild');
    progress.value = 100;
  } finally {
    building.value = false;
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
</style>
