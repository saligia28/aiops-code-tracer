import http from '@/lib/http';

export function useAuth() {
  async function checkAuth(): Promise<boolean> {
    try {
      const res = await http.get<{ authenticated: boolean }>('/api/auth/status');
      return res.data.authenticated;
    } catch {
      return false;
    }
  }

  async function login(password: string): Promise<{ ok: boolean; message?: string }> {
    try {
      await http.post('/api/auth/login', { password });
      return { ok: true };
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        '登录失败';
      return { ok: false, message: msg };
    }
  }

  async function logout(): Promise<void> {
    try {
      await http.post('/api/auth/logout');
    } catch {
      // ignore
    }
  }

  return { checkAuth, login, logout };
}
