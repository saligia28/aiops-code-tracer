<template>
  <TopProjectSelector v-if="!isLoginPage" />
  <TopModelSelector v-if="!isLoginPage" />
  <router-view />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import TopProjectSelector from './components/TopProjectSelector.vue';
import TopModelSelector from './components/TopModelSelector.vue';

const route = useRoute();
const isLoginPage = computed(() => route.name === 'Login');
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
