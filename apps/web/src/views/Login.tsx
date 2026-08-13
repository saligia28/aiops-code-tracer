import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAuth } from '@/hooks/useAuth';
import './Login.css';

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();

  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const pwd = password.trim();
    if (!pwd || loading) return;

    setLoading(true);
    setErrorMsg('');

    const result = await login(pwd);
    setLoading(false);

    if (result.ok) {
      navigate(searchParams.get('redirect') || '/');
    } else {
      setErrorMsg(result.message || '密码错误');
      setPassword('');
      passwordRef.current?.focus();
    }
  }

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  return (
    <div className="login-page">
      <ThemeToggle className="login-theme-toggle" />
      <div className="login-card">
        <div className="login-header">
          <div className="logo-icon">
            <ProjectIcon size={44} />
          </div>
          <h1>逻瞳</h1>
          <p className="login-subtitle">代码智能分析平台</p>
        </div>

        <form className="login-form" onSubmit={handleLogin}>
          <div className="input-group">
            <input
              ref={passwordRef}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="请输入访问密码"
              disabled={loading}
              autoComplete="current-password"
            />
          </div>
          {errorMsg && <div className="error-text">{errorMsg}</div>}
          <button type="submit" className="login-btn" disabled={loading || !password.trim()}>
            {loading ? <span className="spinner" /> : <span>登 录</span>}
          </button>
        </form>
      </div>
    </div>
  );
}
