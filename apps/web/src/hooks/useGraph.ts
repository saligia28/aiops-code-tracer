import { useCallback, useState } from 'react';
import http from '@/lib/http';

export function useGraph() {
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);

  const loadFileGraph = useCallback(async (filePath: string) => {
    setLoading(true);
    try {
      const res = await http.get('/api/graph/file', { params: { path: filePath } });
      setGraphData(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSymbolGraph = useCallback(async (name: string) => {
    setLoading(true);
    try {
      const res = await http.get('/api/graph/symbol', { params: { name } });
      setGraphData(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  return { graphData, loading, loadFileGraph, loadSymbolGraph };
}
