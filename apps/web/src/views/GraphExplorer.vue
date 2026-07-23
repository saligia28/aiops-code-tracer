<template>
  <div class="graph-explorer">
    <PageHeader index="02" kicker="GRAPH" title="图谱浏览器" :back-to="{ name: 'Home' }" />

    <div class="toolbar">
      <el-input v-model="searchQuery" placeholder="搜索符号..." style="width: 300px" />
      <el-select v-model="filterType" placeholder="节点类型" clearable style="width: 160px; margin-left: 12px">
        <el-option label="函数" value="function" />
        <el-option label="组件" value="component" />
        <el-option label="API" value="apiCall" />
        <el-option label="文件" value="file" />
      </el-select>
    </div>

    <div class="graph-canvas" ref="canvasRef">
      <el-empty description="图谱可视化加载中... (AntV G6)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';

const searchQuery = ref('');
const filterType = ref('');
const canvasRef = ref<HTMLDivElement>();

// TODO: 集成 AntV G6 图谱渲染
</script>

<style scoped>
.graph-explorer {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 20px;
}

.toolbar {
  display: flex;
  align-items: center;
  margin: 20px 0;
}

.graph-canvas {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--qg-surface);
}
</style>
