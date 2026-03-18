import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from '@/composables/useAuth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'Home',
      component: () => import('@/views/Home.vue'),
    },
    {
      path: '/answer',
      name: 'Answer',
      component: () => import('@/views/AnswerView.vue'),
    },
    {
      path: '/graph',
      name: 'GraphExplorer',
      component: () => import('@/views/GraphExplorer.vue'),
    },
    {
      path: '/index-manager',
      name: 'IndexManager',
      component: () => import('@/views/IndexManager.vue'),
    },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const { checkAuth } = useAuth();
  const ok = await checkAuth();
  if (!ok) {
    return { name: 'Login', query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
