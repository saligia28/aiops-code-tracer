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
  const [imeHint, setImeHint] = useState(false);

  // 网页无法强制系统输入法切英文（Safari 对密码框会自动切 ABC，Chrome/第三方输入法不会）。
  // 中文输入法下选词上屏的汉字、全角标点（！。）会混进密码导致校验失败，这里直接过滤非 ASCII 字符。
  // 组合期间（isComposing）不动值，否则会打断 IME 候选框；最终由 compositionend 兜底清理。
  function stripNonAscii(e: React.SyntheticEvent<HTMLInputElement>) {
    if ((e.nativeEvent as InputEvent).isComposing) return;
    const el = e.currentTarget;
    const cleaned = el.value.replace(/[^\x20-\x7E]/g, '');
    if (cleaned !== el.value) {
      el.value = cleaned;
      setPassword(cleaned);
      setImeHint(true);
    } else {
      setPassword(el.value);
      if (imeHint && el.value) setImeHint(false);
    }
  }

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
              onChange={stripNonAscii}
              onCompositionEnd={stripNonAscii}
              type="password"
              placeholder="请输入访问密码"
              disabled={loading}
              autoComplete="current-password"
            />
          </div>
          {imeHint && <div className="ime-hint">已过滤中文/全角字符，请用英文输入法输入密码</div>}
          {errorMsg && <div className="error-text">{errorMsg}</div>}
          <button type="submit" className="login-btn" disabled={loading || !password.trim()}>
            {loading ? <span className="spinner" /> : <span>登 录</span>}
          </button>
        </form>
      </div>
    </div>
  );
}
