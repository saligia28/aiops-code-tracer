import axios from 'axios';

const http = axios.create({
  withCredentials: true,
});

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      // 延迟导入 router 避免循环依赖
      const { default: router } = await import('@/router/index');
      router.push('/login');
    }
    return Promise.reject(error);
  },
);

export default http;
