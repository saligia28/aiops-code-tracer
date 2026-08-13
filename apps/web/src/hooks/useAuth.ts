import http from '@/lib/http';

export function useAuth() {
  return { checkAuth, login, logout };
}

export async function checkAuth(): Promise<boolean> {
  try {
    const res = await http.get<{ authenticated: boolean }>('/api/auth/status');
    return res.data.authenticated;
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<{ ok: boolean; message?: string }> {
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

export async function logout(): Promise<void> {
  try {
    await http.post('/api/auth/logout');
  } catch {
    // ignore
  }
}
