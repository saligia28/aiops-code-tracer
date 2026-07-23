<template>
  <div class="app-shell">
    <header v-if="!isPublicPage" class="global-context-bar">
      <button class="global-brand" type="button" @click="router.push('/')">
        <ProjectIcon :size="20" />
        <span>逻瞳</span>
      </button>
      <div class="context-controls">
        <TopProjectSelector />
        <TopModelSelector />
        <div class="theme-toggle-slot">
          <ThemeToggle />
        </div>
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
import ThemeToggle from './components/ThemeToggle.vue';
import ProjectIcon from './components/ProjectIcon.vue';

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
  background: var(--qg-bg);
  border-bottom: 1px solid var(--qg-line);
}

.global-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  height: 34px;
  padding: 0 10px 0 8px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--qg-fg);
  font-family: var(--qg-font-display);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.global-brand:hover {
  background: var(--qg-surface);
}

.context-controls {
  display: flex;
  align-items: center;
  gap: var(--qg-space-2);
  min-width: 0;
}

.theme-toggle-slot {
  display: flex;
  align-items: center;
  flex-shrink: 0;
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

  .theme-toggle-slot {
    display: none;
  }
}
</style>
