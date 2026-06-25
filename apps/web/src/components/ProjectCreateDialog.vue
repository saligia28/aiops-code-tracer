<template>
  <el-dialog
    v-model="visible"
    width="460px"
    :close-on-click-modal="false"
    :show-close="false"
    custom-class="glass-dialog"
  >
    <template #header>
      <div class="glass-dialog-header">
        <span class="glass-dialog-title">新建项目</span>
        <button class="glass-dialog-close" type="button" @click="visible = false">&times;</button>
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
        <input v-model="form.scanPathsStr" class="glass-input" placeholder="src（多个用逗号分隔）" @input="scanPathsTouched = true" />
      </label>
    </div>

    <template #footer>
      <div class="glass-dialog-footer">
        <button class="glass-btn glass-btn-ghost" type="button" @click="visible = false">取消</button>
        <button class="glass-btn glass-btn-primary" type="button" :disabled="creating" @click="handleCreate">
          {{ creating ? '创建中...' : '确认创建' }}
        </button>
      </div>
    </template>
  </el-dialog>

  <!-- 目录浏览弹窗 -->
  <DirectoryBrowser
    v-model="browserVisible"
    :initial-path="form.repoPath"
    @select="form.repoPath = $event"
  />
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useProject, FRAMEWORK_OPTIONS } from '@/composables/useProject';
import type { ProjectFramework } from '@/composables/useProject';
import DirectoryBrowser from './DirectoryBrowser.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [boolean];
  /** 创建成功后通知父级（父级已通过共享的 useProject 状态自动刷新，可选监听）。 */
  created: [];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const { createProject, switchProject } = useProject();

const creating = ref(false);
const browserVisible = ref(false);
const frameworkOptions = FRAMEWORK_OPTIONS;

const form = reactive({
  name: '',
  framework: 'vue3' as ProjectFramework,
  repoPath: '',
  gitUrl: '',
  scanPathsStr: 'src',
});

// 各框架的默认扫描路径，需与后端 preset（@aiops/parser presets.ts）保持一致；
// web 不依赖 @aiops/parser，故在此内联一份最小映射。
const FRAMEWORK_DEFAULT_SCAN_PATHS: Partial<Record<ProjectFramework, string>> = {
  // 整仓扫描，兼容单模块与多模块（<module>/src/main/java）布局；与后端 preset 一致
  java: '.',
};

function defaultScanPathsFor(fw: ProjectFramework): string {
  return FRAMEWORK_DEFAULT_SCAN_PATHS[fw] ?? 'src';
}

// 用户是否手动编辑过扫描路径；未编辑时随 framework 切换同步默认值，编辑后用户输入优先。
const scanPathsTouched = ref(false);

watch(
  () => form.framework,
  (fw) => {
    if (!scanPathsTouched.value) {
      form.scanPathsStr = defaultScanPathsFor(fw);
    }
  },
);

function openBrowser() {
  browserVisible.value = true;
}

function resetForm() {
  form.name = '';
  form.framework = 'vue3';
  form.repoPath = '';
  form.gitUrl = '';
  form.scanPathsStr = defaultScanPathsFor('vue3');
  scanPathsTouched.value = false;
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
      scanPaths,
    });

    ElMessage.success(`项目 "${record.name}" 创建成功`);
    visible.value = false;
    resetForm();

    await switchProject(record.id);
    emit('created');
  } catch (err: unknown) {
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '创建失败';
    ElMessage.error(msg);
  } finally {
    creating.value = false;
  }
}
</script>
