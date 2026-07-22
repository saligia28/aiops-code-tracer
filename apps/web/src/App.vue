<template>
  <div class="app-shell">
    <header v-if="!isPublicPage" class="global-context-bar">
      <button class="global-brand" type="button" @click="router.push('/')">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12l2.5 2.5L16 9" />
        </svg>
        <span>逻瞳</span>
      </button>
      <div class="context-controls">
        <TopProjectSelector />
        <TopModelSelector />
      </div>
    </header>
    <main class="app-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TopProjectSelector from './components/TopProjectSelector.vue';
import TopModelSelector from './components/TopModelSelector.vue';

const route = useRoute();
const router = useRouter();
const isPublicPage = computed(() => Boolean(route.meta.public));
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body,
#app {
  height: 100%;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background-color: #f5f7fa;
  color: #303133;
  overflow: hidden;
}

.app-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.global-context-bar {
  position: relative;
  z-index: 1100;
  flex: 0 0 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 20px;
  overflow: visible;
  background: #fff;
  border-bottom: 1px solid #eef0f4;
}

.global-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  height: 34px;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: 8px;
  background: #fff;
  color: #4f6ef7;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.global-brand:hover {
  background: #f5f7ff;
}

.context-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

@media (max-width: 768px) {
  .global-context-bar,
  .context-controls {
    display: contents;
  }

  .global-brand {
    display: none;
  }
}
</style>
