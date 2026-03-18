import axios from 'axios';
import router from '@/router/index';

const http = axios.create({
  withCredentials: true,
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      router.push('/login');
    }
    return Promise.reject(error);
  },
);

export default http;
