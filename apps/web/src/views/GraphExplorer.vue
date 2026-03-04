<template>
  <div class="graph-explorer">
    <el-page-header @back="$router.push('/')">
      <template #content>图谱浏览器</template>
    </el-page-header>

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

const searchQuery = ref('');
const filterType = ref('');
const canvasRef = ref<HTMLDivElement>();

// TODO: 集成 AntV G6 图谱渲染
</script>

<style scoped>
.graph-explorer {
  padding: 24px 20px;
}

.toolbar {
  display: flex;
  align-items: center;
  margin: 20px 0;
}

.graph-canvas {
  width: 100%;
  height: calc(100vh - 200px);
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
}
</style>
