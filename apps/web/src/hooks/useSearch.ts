import { useCallback, useState } from 'react';
import http from '@/lib/http';

export function useSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await http.get('/api/search', { params: { q } });
      setResults(res.data.results);
    } finally {
      setLoading(false);
    }
  }, []);

  return { query, setQuery, results, loading, search };
}
