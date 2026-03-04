import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
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

export default router;
