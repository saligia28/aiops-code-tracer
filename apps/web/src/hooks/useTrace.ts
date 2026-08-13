import { useCallback, useState } from 'react';
import http from '@/lib/http';

export function useTrace() {
  const [traceResult, setTraceResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const traceForward = useCallback(async (symbol: string, depth = 3) => {
    setLoading(true);
    try {
      const res = await http.get('/api/trace', { params: { symbol, depth } });
      setTraceResult(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  const traceBackward = useCallback(async (target: string, depth = 3) => {
    setLoading(true);
    try {
      const res = await http.get('/api/why', { params: { target, depth } });
      setTraceResult(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  return { traceResult, loading, traceForward, traceBackward };
}
