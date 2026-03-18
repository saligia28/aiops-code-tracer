import { ref } from 'vue';
import http from '@/lib/http';

export function useGraph() {
  const graphData = ref<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const loading = ref(false);

  async function loadFileGraph(filePath: string) {
    loading.value = true;
    try {
      const res = await http.get('/api/graph/file', { params: { path: filePath } });
      graphData.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  async function loadSymbolGraph(name: string) {
    loading.value = true;
    try {
      const res = await http.get('/api/graph/symbol', { params: { name } });
      graphData.value = res.data;
    } finally {
      loading.value = false;
    }
  }

  return { graphData, loading, loadFileGraph, loadSymbolGraph };
}
