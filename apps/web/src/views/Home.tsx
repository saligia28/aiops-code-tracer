import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import http from '@/lib/http';
import { ProjectIcon } from '@/components/ProjectIcon';
import { useCurrentRepo } from '@/hooks/useCurrentRepo';
import { useProject } from '@/hooks/useProject';
import { setPendingQuestion } from '@/hooks/usePendingQuestion';
import './Home.css';

const suggestions = [
  '订单列表的分页是怎么实现的？',
  '工艺审核保存调的是哪个接口？',
  '样衣作废按钮点击后做了什么？',
];

interface IndexStatus {
  totalFiles?: number;
  totalNodes?: number;
  totalEdges?: number;
  status: string;
}

export default function Home() {
  const { currentRepo } = useCurrentRepo();
  const { projects, initialized: projectsInitialized } = useProject();
  const navigate = useNavigate();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [question, setQuestion] = useState('');
  const [loading] = useState(false);
  const [recentQuestions, setRecentQuestions] = useState<string[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);

  const hasHistory = recentQuestions.length > 0;

  // 项目列表已加载且为空 → 禁用提问并引导先建项目；未加载完前不判定，避免闪现提示
  const noProjects = projectsInitialized && projects.length === 0;

  const placeholder = noProjects
    ? '暂无项目，构建后才能提问'
    : hasHistory
      ? '继续提问...'
      : '描述你想了解的代码逻辑';

  function openProjectPanel() {
    window.dispatchEvent(new CustomEvent('open-project-panel'));
  }

  async function fetchIndexStatus() {
    try {
      const res = await http.get('/api/index/status');
      setIndexStatus(res.data);
    } catch {
      setIndexStatus(null);
    }
  }

  function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading || noProjects) return;
    setRecentQuestions((prev) => [trimmed, ...prev]);
    setQuestion('');
    setPendingQuestion(trimmed);
    navigate('/answer');
  }

  // 首屏拉一次，切换仓库后自动刷新 stats
  useEffect(() => {
    void fetchIndexStatus();
  }, [currentRepo]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="home">
      <div className={`home-header${hasHistory ? ' compact' : ''}`}>
        <div className="logo-area">
          <div className="logo-icon">
            <ProjectIcon size={40} />
          </div>
          <h1>逻瞳</h1>
        </div>
        {!hasHistory && <p className="subtitle">用自然语言提问，AI 阅读源码后直接回答</p>}
      </div>

      <div className={`search-area${hasHistory ? ' search-top' : ''}`}>
        <div className="search-box">
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={placeholder}
            onKeyUp={(e) => {
              if (e.key === 'Enter') ask(question);
            }}
            disabled={loading || noProjects}
          />
          <button
            className="ask-btn"
            onClick={() => ask(question)}
            disabled={loading || noProjects || !question.trim()}
          >
            {loading ? (
              <span className="spinner" />
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            )}
          </button>
        </div>
        {noProjects && (
          <div className="no-project-hint">
            暂无项目，请先
            <button className="hint-link" onClick={openProjectPanel}>
              新建并构建项目
            </button>
            后再提问
          </div>
        )}
        {!hasHistory && !noProjects && (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button key={s} className="suggestion-chip" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {!hasHistory && !noProjects && (
          <div className="tool-links">
            <button className="tool-link" onClick={() => navigate('/propose-patch')}>
              ✎ 生成修改提案
            </button>
          </div>
        )}
      </div>

      {!hasHistory && indexStatus && (
        <div className="stats-bar">
          {currentRepo && (
            <span className="stat-pill repo-pill">
              <strong>{currentRepo}</strong>
            </span>
          )}
          {indexStatus.totalFiles ? (
            <span className="stat-pill">
              <strong>{indexStatus.totalFiles}</strong> 文件
            </span>
          ) : null}
          {indexStatus.totalNodes ? (
            <span className="stat-pill">
              <strong>{indexStatus.totalNodes}</strong> 符号
            </span>
          ) : null}
          {indexStatus.totalEdges ? (
            <span className="stat-pill">
              <strong>{indexStatus.totalEdges}</strong> 关系
            </span>
          ) : null}
          <span className={`stat-pill status ${indexStatus.status}`}>
            {indexStatus.status === 'ready'
              ? '索引就绪'
              : indexStatus.status === 'building'
                ? '构建中...'
                : '未就绪'}
          </span>
        </div>
      )}
    </div>
  );
}
