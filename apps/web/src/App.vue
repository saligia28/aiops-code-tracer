<template>
  <TopProjectSelector />
  <TopModelSelector />
  <router-view />
</template>

<script setup lang="ts">
import TopProjectSelector from './components/TopProjectSelector.vue';
import TopModelSelector from './components/TopModelSelector.vue';
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
  color: #303133;
}
</style>
