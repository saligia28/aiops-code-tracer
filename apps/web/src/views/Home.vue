<template>
  <div class="home">
    <div class="home-header">
      <h1>代码智能分析平台</h1>
      <p class="subtitle">用自然语言提问，系统自动追踪代码逻辑链路</p>
    </div>

    <div class="search-section">
      <el-input
        v-model="question"
        placeholder="输入你的问题，例如：自制样工艺审核页面什么时候展示作废按钮？"
        size="large"
        @keyup.enter="handleAsk"
      >
        <template #append>
          <el-button @click="handleAsk" :loading="loading">提问</el-button>
        </template>
      </el-input>
    </div>

    <div class="suggestions">
      <p>试试这些问题:</p>
      <div class="suggestion-tags">
        <el-tag
          v-for="s in suggestions"
          :key="s"
          effect="plain"
          class="suggestion-tag"
          @click="question = s"
        >
          {{ s }}
        </el-tag>
      </div>
    </div>

    <el-row :gutter="20" class="overview">
      <el-col :span="12">
        <el-card header="项目概览">
          <div class="stats">
            <div class="stat-item">
              <span class="stat-value">--</span>
              <span class="stat-label">文件数</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">--</span>
              <span class="stat-label">函数数</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">--</span>
              <span class="stat-label">API 数</span>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card header="最近提问">
          <el-empty v-if="!recentQuestions.length" description="暂无记录" />
          <div v-else>
            <p v-for="q in recentQuestions" :key="q" class="recent-item">Q: {{ q }}</p>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const question = ref('');
const loading = ref(false);
const recentQuestions = ref<string[]>([]);

const suggestions = [
  '订单列表的分页是怎么实现的？',
  '工艺审核保存调的是哪个接口？',
  '样衣作废按钮点击后做了什么？',
];

function handleAsk() {
  if (!question.value.trim()) return;
  recentQuestions.value.unshift(question.value);
  router.push({ name: 'Answer', query: { q: question.value } });
}
</script>

<style scoped>
.home {
  max-width: 900px;
  margin: 0 auto;
  padding: 60px 20px;
}

.home-header {
  text-align: center;
  margin-bottom: 40px;
}

.home-header h1 {
  font-size: 28px;
  margin-bottom: 8px;
}

.subtitle {
  color: #909399;
}

.search-section {
  margin-bottom: 24px;
}

.suggestions {
  margin-bottom: 32px;
}

.suggestions p {
  color: #909399;
  margin-bottom: 8px;
  font-size: 14px;
}

.suggestion-tag {
  cursor: pointer;
  margin-right: 8px;
  margin-bottom: 8px;
}

.overview {
  margin-top: 20px;
}

.stats {
  display: flex;
  justify-content: space-around;
}

.stat-item {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 24px;
  font-weight: bold;
  color: #409eff;
}

.stat-label {
  font-size: 12px;
  color: #909399;
}

.recent-item {
  padding: 6px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
  color: #606266;
}
</style>
