<template>
  <img
    class="project-icon"
    src="/project-icon.png"
    alt=""
    aria-hidden="true"
    :width="size"
    :height="size"
    draggable="false"
  />
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number;
}>(), {
  size: 24,
});
</script>

<style scoped>
.project-icon {
  display: block;
  object-fit: contain;
  flex-shrink: 0;
}
</style>
