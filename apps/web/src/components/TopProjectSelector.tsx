import { useEffect, useRef, useState } from 'react';
import { ElMessage } from '@/components/el';
import http from '@/lib/http';
import { useProject, frameworkLabel } from '@/hooks/useProject';
import { ProjectCreateDialog } from './ProjectCreateDialog';
import { ProjectDeleteDialog, type DeleteTarget } from './ProjectDeleteDialog';
import '@/styles/glass-dialog.css';
import './TopProjectSelector.css';

export function TopProjectSelector() {
  const { currentProjectId, currentProjectName, projects, loading, fetchProjects, switchProject, buildProject } =
    useProject();

  const [expanded, setExpanded] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  // WebSocket 回调里要读最新的 buildingId，用 ref 兜住闭包。
  const buildingIdRef = useRef<string | null>(null);
  buildingIdRef.current = buildingId;

  // ---- 删除确认（关联风险在打开前查询并填入 deleteTarget，弹窗本体见 ProjectDeleteDialog） ----
  const [deleteDialogVisible, setDeleteDialogVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>({ id: '', name: '', risks: [] });

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      window.dispatchEvent(new CustomEvent('floating-panel-open', { detail: 'project' }));
    }
  }

  useEffect(() => {
    function handlePanelOpen(event: Event) {
      const customEvent = event as CustomEvent<string>;
      if (customEvent.detail !== 'project') {
        setExpanded(false);
      }
    }

    function handleClickOutside(event: Event) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (floatingRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.glass-dialog')) return;
      setExpanded(false);
    }

    window.addEventListener('floating-panel-open', handlePanelOpen as EventListener);
    document.addEventListener('pointerdown', handleClickOutside);
    void fetchProjects();

    // ---- WebSocket 监听构建进度 ----
    let progressWs: WebSocket | null = null;
    let disposed = false;

    function connectProgressWs() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/progress`);

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as { type?: string; status?: string; phase?: string };
          if (data.type !== 'index-progress') return;

          if (data.status === 'ready' || data.status === 'error') {
            // 仅在用户主动触发构建时才弹提示，避免服务初始化/重连时误弹
            if (buildingIdRef.current) {
              if (data.status === 'ready') {
                ElMessage.success('图谱构建完成');
              } else {
                ElMessage.error('图谱构建失败');
              }
            }
            setBuildingId(null);
            void fetchProjects();
          }
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        setTimeout(() => {
          if (!disposed && progressWs === ws) connectProgressWs();
        }, 3000);
      };

      progressWs = ws;
    }

    connectProgressWs();

    return () => {
      disposed = true;
      window.removeEventListener('floating-panel-open', handlePanelOpen as EventListener);
      document.removeEventListener('pointerdown', handleClickOutside);
      if (progressWs) {
        const ws = progressWs;
        progressWs = null;
        ws.close();
      }
    };
    // 只在挂载/卸载时接线，与迁移前的 onMounted/onUnmounted 一致。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSwitch(id: string) {
    if (id === currentProjectId) {
      setExpanded(false);
      return;
    }
    try {
      await switchProject(id);
      const name = projects.find((p) => p.id === id)?.name ?? id;
      ElMessage.success(`已切换到 ${name}`);
      setExpanded(false);
    } catch {
      ElMessage.error('切换项目失败');
    }
  }

  async function handleBuild(id: string, name: string) {
    setBuildingId(id);
    try {
      await buildProject(id);
      ElMessage.info(`"${name}" 构建任务已提交，完成后自动刷新`);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        '构建失败';
      ElMessage.error(msg);
      setBuildingId(null);
    }
  }

  // ---- 删除流程：先查关联风险，再打开确认弹窗 ----
  async function handleDeleteCheck(id: string, name: string) {
    let risks: string[] = [];
    try {
      const res = await http.get<{ risks: string[] }>(`/api/projects/${id}/relations`);
      risks = res.data.risks;
    } catch {
      // 查询失败也允许继续删除
    }
    setDeleteTarget({ id, name, risks });
    setDeleteDialogVisible(true);
  }

  return (
    <div ref={floatingRef} className={`project-floating${expanded ? ' is-expanded' : ''}`}>
      <button
        className={`project-trigger${expanded ? ' is-active' : ''}${loading ? ' is-loading' : ''}`}
        type="button"
        aria-controls="project-selector-panel"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className="trigger-dot" />
        <span className="mobile-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 6a2 2 0 012-2h2.586a1 1 0 01.707.293l1.414 1.414A1 1 0 0010.414 6H15a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
          </svg>
        </span>
        <span className="trigger-body">
          <span className="trigger-label">{currentProjectName || '未选择项目'}</span>
          <span className="trigger-badge">{projects.length} 项目</span>
        </span>
      </button>

      {expanded && (
        <div id="project-selector-panel" className="project-panel">
          <div className="panel-header">
            <div className="panel-title">项目切换</div>
            <button className="panel-close" type="button" onClick={() => setExpanded(false)}>
              收起
            </button>
          </div>

          {loading ? (
            <div className="panel-status">正在加载...</div>
          ) : projects.length === 0 ? (
            <div className="panel-status">暂无项目，点击下方按钮创建</div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`project-item${p.id === currentProjectId ? ' active' : ''}`}
                >
                  <button className="project-main" type="button" onClick={() => handleSwitch(p.id)}>
                    <span className="project-info">
                      <span className="project-name">{p.name}</span>
                      <span className="project-fw">{frameworkLabel(p.framework)}</span>
                    </span>
                    {p.hasGraph ? (
                      <span className="project-meta">{p.totalNodes ?? '-'} 符号</span>
                    ) : (
                      <span className="project-meta no-graph">未构建</span>
                    )}
                  </button>
                  <button
                    className={`project-build-btn${buildingId === p.id ? ' building' : ''}`}
                    type="button"
                    title={p.hasGraph ? '重新构建图谱' : '构建图谱'}
                    disabled={buildingId === p.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleBuild(p.id, p.name);
                    }}
                  >
                    {buildingId === p.id ? '构建中' : '构建'}
                  </button>
                  <button
                    className="project-delete-btn"
                    type="button"
                    title="删除项目"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteCheck(p.id, p.name);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="new-project-btn" type="button" onClick={() => setDialogVisible(true)}>
            + 新建项目
          </button>
        </div>
      )}

      {/* 新建 / 删除项目弹窗（目录浏览器嵌在新建弹窗内） */}
      <ProjectCreateDialog modelValue={dialogVisible} onUpdateModelValue={setDialogVisible} />
      <ProjectDeleteDialog
        modelValue={deleteDialogVisible}
        onUpdateModelValue={setDeleteDialogVisible}
        target={deleteTarget}
      />
    </div>
  );
}
