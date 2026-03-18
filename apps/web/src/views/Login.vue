<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12l2.5 2.5L16 9" />
          </svg>
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
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #e8ecf4 100%);
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 380px;
  background: #fff;
  border-radius: 20px;
  padding: 48px 36px 40px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.06);
  border: 1px solid #eef0f4;
}

.login-header {
  text-align: center;
  margin-bottom: 36px;
}

.logo-icon {
  color: #4f6ef7;
  margin-bottom: 12px;
}

.login-header h1 {
  font-size: 28px;
  font-weight: 700;
  color: #1a1a2e;
  margin-bottom: 6px;
}

.login-subtitle {
  color: #8b8fa3;
  font-size: 14px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1.5px solid #e2e4ea;
  border-radius: 12px;
  font-size: 15px;
  color: #1a1a2e;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
  background: #f9fafb;
}

.input-group input::placeholder {
  color: #b0b4c3;
}

.input-group input:focus {
  border-color: #4f6ef7;
  box-shadow: 0 0 0 3px rgba(79, 110, 247, 0.1);
  background: #fff;
}

.error-text {
  color: #e74c3c;
  font-size: 13px;
  text-align: center;
  margin: -4px 0;
}

.login-btn {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  border: none;
  background: #4f6ef7;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, opacity 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
}

.login-btn:hover:not(:disabled) {
  background: #3d5bd9;
}

.login-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
