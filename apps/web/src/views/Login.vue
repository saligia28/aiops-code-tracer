<template>
  <div class="login-page">
    <ThemeToggle class="login-theme-toggle" />
    <div class="login-card">
      <div class="login-header">
        <div class="logo-icon">
          <ProjectIcon :size="44" />
        </div>
        <h1>逻瞳</h1>
        <p class="login-subtitle">代码智能分析平台</p>
      </div>

      <form class="login-form" @submit.prevent="handleLogin">
        <div class="input-group">
          <input
            ref="passwordRef"
            v-model="password"
            type="password"
            placeholder="请输入访问密码"
            :disabled="loading"
            autocomplete="current-password"
          />
        </div>
        <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
        <button type="submit" class="login-btn" :disabled="loading || !password.trim()">
          <span v-if="loading" class="spinner" />
          <span v-else>登 录</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import ProjectIcon from '@/components/ProjectIcon.vue';
import ThemeToggle from '@/components/ThemeToggle.vue';
import { useAuth } from '@/composables/useAuth';

const router = useRouter();
const { login } = useAuth();

const passwordRef = ref<HTMLInputElement>();
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

async function handleLogin() {
  const pwd = password.value.trim();
  if (!pwd || loading.value) return;

  loading.value = true;
  errorMsg.value = '';

  const result = await login(pwd);
  loading.value = false;

  if (result.ok) {
    const redirect = (router.currentRoute.value.query.redirect as string) || '/';
    router.push(redirect);
  } else {
    errorMsg.value = result.message || '密码错误';
    password.value = '';
    passwordRef.value?.focus();
  }
}

onMounted(() => {
  passwordRef.value?.focus();
});
</script>

<style scoped>
.login-page {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--qg-bg);
  padding: 20px;
}

.login-theme-toggle {
  position: absolute;
  top: var(--qg-space-4);
  right: var(--qg-space-4);
  z-index: 1;
}

.login-card {
  width: 100%;
  max-width: 380px;
  background: var(--qg-elevated);
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  padding: 48px 36px 40px;
}

.login-header {
  text-align: center;
  margin-bottom: 36px;
}

.logo-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
}

.login-header h1 {
  font-family: var(--qg-font-display);
  font-size: 28px;
  font-weight: 500;
  color: var(--qg-fg);
  letter-spacing: -0.3px;
  margin-bottom: 6px;
}

.login-subtitle {
  color: var(--qg-muted);
  font-size: 14px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--qg-space-4);
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--qg-line);
  border-radius: 2px;
  font-size: 15px;
  color: var(--qg-fg);
  outline: none;
  transition: border-color var(--qg-duration) ease, box-shadow var(--qg-duration) ease;
  box-sizing: border-box;
  background: var(--qg-bg);
}

.input-group input::placeholder {
  color: var(--qg-faint);
}

.input-group input:focus {
  border-color: var(--qg-focus);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--qg-focus) 20%, transparent);
}

.input-group input:-webkit-autofill,
.input-group input:-webkit-autofill:hover,
.input-group input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--qg-fg);
  -webkit-box-shadow: 0 0 0 1000px var(--qg-bg) inset;
  caret-color: var(--qg-fg);
  transition: background-color 9999s ease-out 0s;
}

.error-text {
  color: var(--qg-danger);
  font-size: 13px;
  text-align: center;
  margin: -4px 0;
}

.login-btn {
  width: 100%;
  padding: 12px;
  border-radius: 2px;
  border: 1px solid var(--qg-fg);
  background: var(--qg-fg);
  color: var(--qg-bg);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--qg-duration) ease, background-color var(--qg-duration) ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
}

.login-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid color-mix(in srgb, var(--qg-bg) 35%, transparent);
  border-top-color: var(--qg-bg);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
