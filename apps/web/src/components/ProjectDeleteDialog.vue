<template>
  <el-dialog
    v-model="visible"
    width="420px"
    :close-on-click-modal="false"
    :show-close="false"
    append-to-body
    custom-class="glass-dialog glass-dialog-danger"
  >
    <template #header>
      <div class="glass-dialog-header">
        <span class="glass-dialog-title">删除项目</span>
        <button class="glass-dialog-close" type="button" @click="visible = false">&times;</button>
      </div>
    </template>

    <p class="glass-dialog-body-text">
      确定要删除项目「<strong>{{ target.name }}</strong>」吗？
    </p>
    <div v-if="target.risks.length > 0" class="delete-risks">
      <div class="risk-title">风险提示</div>
      <ul class="risk-list">
        <li v-for="(r, i) in target.risks" :key="i">{{ r }}</li>
      </ul>
    </div>
    <label class="glass-checkbox">
      <input type="checkbox" v-model="deleteData" />
      <span>同时删除图谱数据（不可恢复）</span>
    </label>

    <template #footer>
      <div class="glass-dialog-footer">
        <button class="glass-btn glass-btn-ghost" type="button" @click="visible = false">取消</button>
        <button class="glass-btn glass-btn-danger" type="button" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? '删除中...' : '确认删除' }}
        </button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useProject } from '@/composables/useProject';

interface DeleteTarget {
  id: string;
  name: string;
  risks: string[];
}

const props = defineProps<{
  modelValue: boolean;
  /** 由父级在打开前填好（含已查询的关联风险）。 */
  target: DeleteTarget;
}>();
const emit = defineEmits<{
  'update:modelValue': [boolean];
  deleted: [];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const { deleteProject } = useProject();

const deleting = ref(false);
const deleteData = ref(false);

// 每次打开时重置「删除数据」勾选（与原 handleDeleteCheck 行为一致）。
watch(
  () => props.modelValue,
  (open) => {
    if (open) deleteData.value = false;
  },
);

async function confirmDelete() {
  deleting.value = true;
  try {
    await deleteProject(props.target.id, deleteData.value);
    ElMessage.success(`项目「${props.target.name}」已删除`);
    visible.value = false;
    emit('deleted');
  } catch {
    ElMessage.error('删除失败');
  } finally {
    deleting.value = false;
  }
}
</script>
