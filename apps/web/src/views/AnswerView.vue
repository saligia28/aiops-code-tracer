<template>
  <div class="answer-view">
    <div class="question-bar">
      <el-page-header @back="$router.push('/')">
        <template #content>
          <span>{{ question }}</span>
        </template>
      </el-page-header>
    </div>

    <el-card class="answer-card" v-loading="loading">
      <template #header>回答</template>
      <div class="answer-text">{{ answer || '正在分析中...' }}</div>
    </el-card>

    <el-card class="evidence-card" v-if="evidence.length">
      <template #header>证据链</template>
      <el-steps direction="vertical" :active="evidence.length">
        <el-step
          v-for="(e, i) in evidence"
          :key="i"
          :title="e.label"
          :description="`${e.file}:${e.line}`"
        />
      </el-steps>
    </el-card>

    <el-card class="followup-card" v-if="followUp.length">
      <template #header>追问</template>
      <el-tag
        v-for="f in followUp"
        :key="f"
        effect="plain"
        class="followup-tag"
        @click="askFollowUp(f)"
      >
        {{ f }}
      </el-tag>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import axios from 'axios';

const route = useRoute();
const router = useRouter();

const question = ref('');
const answer = ref('');
const evidence = ref<{ file: string; line: number; code: string; label: string }[]>([]);
const followUp = ref<string[]>([]);
const loading = ref(false);

async function fetchAnswer(q: string) {
  if (!q) return;
  question.value = q;
  answer.value = '';
  evidence.value = [];
  followUp.value = [];
  loading.value = true;
  try {
    const res = await axios.post('/api/ask', { question: q });
    answer.value = res.data.answer;
    evidence.value = res.data.evidence;
    followUp.value = res.data.followUp;
  } catch {
    answer.value = '查询失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.query.q as string,
  (q) => fetchAnswer(q),
  { immediate: true },
);

function askFollowUp(q: string) {
  router.push({ name: 'Answer', query: { q } });
}
</script>

<style scoped>
.answer-view {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 20px;
}

.question-bar {
  margin-bottom: 20px;
}

.answer-card,
.evidence-card,
.followup-card {
  margin-bottom: 16px;
}

.answer-text {
  white-space: pre-wrap;
  line-height: 1.8;
}

.followup-tag {
  cursor: pointer;
  margin-right: 8px;
  margin-bottom: 8px;
}
</style>
