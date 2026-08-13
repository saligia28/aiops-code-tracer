import axios from 'axios';
import { navigateTo } from '@/lib/navigation';

const http = axios.create({
  withCredentials: true,
});

http.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      navigateTo('/login');
    }
    return Promise.reject(error);
  },
);

export default http;
