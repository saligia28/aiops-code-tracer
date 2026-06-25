<template>
  <el-dialog
    v-model="visible"
    width="520px"
    :close-on-click-modal="false"
    :show-close="false"
    append-to-body
    custom-class="glass-dialog"
  >
    <template #header>
      <div class="glass-dialog-header">
        <span class="glass-dialog-title">选择仓库目录</span>
        <button class="glass-dialog-close" type="button" @click="visible = false">&times;</button>
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
          <button class="glass-btn glass-btn-ghost" type="button" @click="visible = false">取消</button>
          <button class="glass-btn glass-btn-primary" type="button" @click="confirmBrowser">选择此目录</button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http from '@/lib/http';

const props = defineProps<{
  modelValue: boolean;
  /** 打开时的起始目录，留空则由后端给默认（用户主目录等）。 */
  initialPath?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [boolean];
  /** 用户点击「选择此目录」后回传选中的绝对路径。 */
  select: [string];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

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

function confirmBrowser() {
  emit('select', browserInfo.current);
  visible.value = false;
}

// 每次打开都从 initialPath 重新拉取（与原 openBrowser 行为一致）。
watch(
  () => props.modelValue,
  (open) => {
    if (open) void fetchDirs(props.initialPath || '');
  },
);
</script>
