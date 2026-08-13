import { useEffect, useRef, useState } from 'react';
import http from '@/lib/http';
import { PageHeader } from '@/components/PageHeader';
import { ElButton, ElCard, ElDescriptions, ElProgress, ElTag } from '@/components/el';
import { useCurrentRepo } from '@/hooks/useCurrentRepo';
import './IndexManager.css';

interface IndexStatus {
  status?: string;
  repoName?: string;
  totalFiles?: number;
  totalNodes?: number;
  totalEdges?: number;
  lastBuildTime?: string;
  phase?: string;
  message?: string;
  progress?: number;
  error?: string;
}

function statusTagType(s?: string) {
  if (s === 'ready') return 'success' as const;
  if (s === 'building') return 'warning' as const;
  if (s === 'error') return 'danger' as const;
  return 'info' as const;
}

export default function IndexManager() {
  const { currentRepo } = useCurrentRepo();

  const [status, setStatus] = useState<IndexStatus>({});
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState(0);
  // WebSocket 回调里要基于最新 status 合并，用 ref 兜住闭包。
  const statusRef = useRef<IndexStatus>({});
  statusRef.current = status;

  async function refreshStatus() {
    try {
      const res = await http.get('/api/index/status');
      const next = res.data as IndexStatus;
      setStatus(next);
      if (next.status === 'building') {
        setBuilding(true);
        setProgress(Number(next.progress) || 0);
      } else {
        setBuilding(false);
        if (typeof next.progress === 'number') {
          setProgress(next.progress);
        }
      }
    } catch {
      // ignore
    }
  }

  // 切换仓库后刷新索引状态
  useEffect(() => {
    void refreshStatus();
  }, [currentRepo]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/progress`);

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type !== 'index-progress') return;
        setStatus({
          ...statusRef.current,
          status: payload.status,
          repoName: payload.repoName ?? statusRef.current.repoName,
          progress: payload.progress,
          phase: payload.phase,
          message: payload.message,
          error: payload.error,
        });
        setProgress(Number(payload.progress) || 0);
        setBuilding(payload.status === 'building');
        if (payload.status === 'ready' || payload.status === 'error') {
          void refreshStatus();
        }
      } catch {
        // ignore invalid message
      }
    };

    return () => socket.close();
  }, []);

  async function triggerBuild() {
    try {
      const res = await http.post('/api/index/build');
      if (res.data?.status === 'building') {
        setBuilding(true);
        setProgress(0);
        setStatus((prev) => ({
          ...prev,
          status: 'building',
          message: res.data.message,
          repoName: res.data.repoName,
        }));
      }
      await refreshStatus();
    } catch {
      // ignore
    }
  }

  async function triggerRebuild() {
    try {
      const res = await http.post('/api/index/rebuild');
      if (res.data?.status === 'building') {
        setBuilding(true);
        setProgress(0);
        setStatus((prev) => ({
          ...prev,
          status: 'building',
          message: res.data.message,
          repoName: res.data.repoName,
        }));
      }
      await refreshStatus();
    } catch {
      // ignore
    }
  }

  return (
    <div className="index-manager">
      <PageHeader index="03" kicker="INDEX" title="索引管理" backTo="/" />

      <ElCard className="status-card" header="索引状态">
        <ElDescriptions
          column={2}
          border
          items={[
            { label: '状态', content: <ElTag type={statusTagType(status.status)}>{status.status}</ElTag> },
            { label: '仓库', content: status.repoName || '--' },
            { label: '文件数', content: status.totalFiles || '--' },
            { label: '节点数', content: status.totalNodes || '--' },
            { label: '边数', content: status.totalEdges || '--' },
            { label: '最近构建', content: status.lastBuildTime || '--' },
            { label: '阶段', content: status.phase || '--' },
            { label: '信息', content: status.message || '--' },
          ]}
        />
      </ElCard>

      <div className="actions">
        <ElButton type="primary" onClick={triggerBuild} loading={building}>
          全量构建
        </ElButton>
        <ElButton onClick={triggerRebuild} loading={building}>
          增量重建
        </ElButton>
      </div>

      {building && (
        <ElCard className="progress-card" header="构建进度">
          <ElProgress percentage={progress} status={progress === 100 ? 'success' : undefined} />
          <p className="progress-text">{status.message || '处理中...'}</p>
        </ElCard>
      )}
    </div>
  );
}
