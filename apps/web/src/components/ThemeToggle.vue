<template>
  <button
    type="button"
    class="theme-toggle"
    :aria-label="current === 'dark' ? '切换到白天模式' : '切换到夜间模式'"
    @click="toggle"
  >
    <svg
      v-if="current === 'dark'"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
    <svg
      v-else
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { nextTheme, applyTheme, type Theme } from '@/lib/theme';

const current = ref<Theme>((document.documentElement.dataset.theme as Theme) || 'light');

function toggle() {
  const t = nextTheme(current.value);
  applyTheme(t);
  try {
    localStorage.setItem('theme', t);
  } catch {
    /* localStorage 不可用时静默降级 */
  }
  current.value = t;
}
</script>

<style scoped>
.theme-toggle {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  background: transparent;
  color: var(--qg-fg);
  cursor: pointer;
  transition: border-color var(--qg-duration) ease;
}

.theme-toggle:hover {
  border-color: var(--qg-line-strong);
}

@media (max-width: 768px) {
  .theme-toggle {
    width: 44px;
    height: 44px;
  }
}
</style>
