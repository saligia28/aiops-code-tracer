import { useEffect, useRef, useState } from 'react';
import http from '@/lib/http';
import { PageHeader } from '@/components/PageHeader';
import { Button, Card, Descriptions, Progress, Tag } from 'antd';
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

/** 索引状态 → 标签配色（与迁移前 el-tag 的 success/warning/danger/info 一一对应）。 */
function statusTagColor(s?: string) {
  if (s === 'ready') return 'success' as const;
  if (s === 'building') return 'warning' as const;
  if (s === 'error') return 'error' as const;
  return 'default' as const;
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

      <Card className="status-card" title="索引状态">
        <Descriptions
          column={2}
          bordered
          items={[
            {
              key: 'status',
              label: '状态',
              children: <Tag color={statusTagColor(status.status)}>{status.status}</Tag>,
            },
            { key: 'repo', label: '仓库', children: status.repoName || '--' },
            { key: 'files', label: '文件数', children: status.totalFiles || '--' },
            { key: 'nodes', label: '节点数', children: status.totalNodes || '--' },
            { key: 'edges', label: '边数', children: status.totalEdges || '--' },
            { key: 'lastBuild', label: '最近构建', children: status.lastBuildTime || '--' },
            { key: 'phase', label: '阶段', children: status.phase || '--' },
            { key: 'message', label: '信息', children: status.message || '--' },
          ]}
        />
      </Card>

      <div className="actions">
        <Button type="primary" onClick={triggerBuild} loading={building}>
          全量构建
        </Button>
        <Button onClick={triggerRebuild} loading={building}>
          增量重建
        </Button>
      </div>

      {building && (
        <Card className="progress-card" title="构建进度">
          <Progress percent={progress} status={progress === 100 ? 'success' : 'active'} />
          <p className="progress-text">{status.message || '处理中...'}</p>
        </Card>
      )}
    </div>
  );
}
