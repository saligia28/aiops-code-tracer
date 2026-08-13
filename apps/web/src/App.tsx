import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AntdProvider } from './components/antd/AntdProvider';
import { TopProjectSelector } from './components/TopProjectSelector';
import { TopModelSelector } from './components/TopModelSelector';
import { ThemeToggle } from './components/ThemeToggle';
import { ProjectIcon } from './components/ProjectIcon';
import { checkAuth } from './hooks/useAuth';
import { setNavigate } from './lib/navigation';
import './App.css';

// 路由级懒加载：与迁移前 vue-router 的 `() => import(...)` 一一对应，保持分包。
const Login = lazy(() => import('./views/Login'));
const Home = lazy(() => import('./views/Home'));
const AnswerView = lazy(() => import('./views/AnswerView'));
const GraphExplorer = lazy(() => import('./views/GraphExplorer'));
const IndexManager = lazy(() => import('./views/IndexManager'));
const ProposePatch = lazy(() => import('./views/ProposePatch'));

/** 免登录页面（迁移前是路由 meta.public）。 */
const PUBLIC_PATHS = new Set(['/login']);

/**
 * 登录守卫 —— 等价迁移前的 router.beforeEach：非公开路由先问一次 /api/auth/status，
 * 未登录则跳登录页并带上 redirect。已经确认登录过之后再切路由不清空视图，
 * 避免每次导航闪一下白屏（vue-router 是在旧页面上等守卫返回的）。
 */
function RequireAuth() {
  const location = useLocation();
  const [state, setState] = useState<'pending' | 'ok' | 'denied'>('pending');
  const authenticatedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void checkAuth().then((ok) => {
      if (cancelled) return;
      authenticatedOnce.current = authenticatedOnce.current || ok;
      setState(ok ? 'ok' : 'denied');
    });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (state === 'pending' && !authenticatedOnce.current) return null;
  if (state === 'denied') {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
  }
  return <Outlet />;
}

/** 全局外壳：顶部上下文栏（公开页不显示）+ 内容区。 */
function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isPublicPage = PUBLIC_PATHS.has(location.pathname);

  // 把 navigate 交给 axios 拦截器用（401 → /login）。
  useEffect(() => {
    setNavigate((to) => navigate(to));
  }, [navigate]);

  return (
    <div className="app-shell">
      {!isPublicPage && (
        <header className="global-context-bar">
          <button className="global-brand" type="button" onClick={() => navigate('/')}>
            <ProjectIcon size={20} />
            <span>逻瞳</span>
          </button>
          <div className="context-controls">
            <TopProjectSelector />
            <TopModelSelector />
            <div className="theme-toggle-slot">
              <ThemeToggle />
            </div>
          </div>
        </header>
      )}
      <main className="app-content">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AntdProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Home />} />
            <Route path="/answer" element={<AnswerView />} />
            <Route path="/graph" element={<GraphExplorer />} />
            <Route path="/index-manager" element={<IndexManager />} />
            <Route path="/propose-patch" element={<ProposePatch />} />
          </Route>
        </Route>
      </Routes>
    </AntdProvider>
  );
}
