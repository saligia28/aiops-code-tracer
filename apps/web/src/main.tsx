import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/quiet-grid.css';
import App from './App';

// 刻意不套 <StrictMode>：它只在开发态生效，会把 effect 跑两遍
// （重复拉配置、重复建 /ws/progress 连接），让开发态与生产态、
// 以及与迁移前的行为不一致；这里以"所见即所得"优先。
createRoot(document.getElementById('app')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
