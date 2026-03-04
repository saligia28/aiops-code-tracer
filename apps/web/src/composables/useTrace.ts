import { ref } from 'vue';
import axios from 'axios';

export function useTrace() {
  const traceResult = ref<any>(null);
  const loading = ref(false);

  async function traceForward(symbol: string, depth = 3) {
    loading.value = true;
    try {
      const res = await axios.get('/api/trace', { params: { symbol, depth } });
      traceResult.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function traceBackward(target: string, depth = 3) {
    loading.value = true;
    try {
      const res = await axios.get('/api/why', { params: { target, depth } });
      traceResult.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  return { traceResult, loading, traceForward, traceBackward };
}
