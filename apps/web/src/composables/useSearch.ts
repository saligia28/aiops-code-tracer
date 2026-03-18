import { ref } from 'vue';
import http from '@/lib/http';

export function useSearch() {
  const query = ref('');
  const results = ref<any[]>([]);
  const loading = ref(false);

  async function search(q: string) {
    loading.value = true;
    try {
      const res = await http.get('/api/search', { params: { q } });
      results.value = res.data.results;
    } finally {
      loading.value = false;
    }
  }

  return { query, results, loading, search };
}
