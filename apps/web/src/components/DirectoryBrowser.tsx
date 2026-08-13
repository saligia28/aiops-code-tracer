import { useEffect, useMemo, useState } from 'react';
import { ElDialog, ElMessage } from '@/components/el';
import http from '@/lib/http';

interface BrowserInfo {
  current: string;
  parent: string | null;
  dirs: string[];
  isGitRepo: boolean;
  hasPackageJson: boolean;
}

const EMPTY: BrowserInfo = {
  current: '',
  parent: null,
  dirs: [],
  isGitRepo: false,
  hasPackageJson: false,
};

export interface DirectoryBrowserProps {
  modelValue: boolean;
  onUpdateModelValue: (value: boolean) => void;
  /** 打开时的起始目录，留空则由后端给默认（用户主目录等）。 */
  initialPath?: string;
  /** 用户点击「选择此目录」后回传选中的绝对路径。 */
  onSelect: (path: string) => void;
}

export function DirectoryBrowser({
  modelValue,
  onUpdateModelValue,
  initialPath,
  onSelect,
}: DirectoryBrowserProps) {
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserInfo, setBrowserInfo] = useState<BrowserInfo>(EMPTY);

  const pathSegments = useMemo(() => {
    if (!browserInfo.current) return [];
    const parts = browserInfo.current.split('/').filter(Boolean);
    const segs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      segs.push({ label: part, path: acc });
    }
    return segs;
  }, [browserInfo.current]);

  async function fetchDirs(dirPath: string) {
    setBrowserLoading(true);
    try {
      const res = await http.get<BrowserInfo>('/api/fs/dirs', { params: { path: dirPath } });
      setBrowserInfo({
        current: res.data.current,
        parent: res.data.parent,
        dirs: res.data.dirs,
        isGitRepo: res.data.isGitRepo,
        hasPackageJson: res.data.hasPackageJson,
      });
    } catch {
      ElMessage.error('读取目录失败');
    } finally {
      setBrowserLoading(false);
    }
  }

  function navigateTo(dirPath: string) {
    void fetchDirs(dirPath);
  }

  function confirmBrowser() {
    onSelect(browserInfo.current);
    onUpdateModelValue(false);
  }

  // 每次打开都从 initialPath 重新拉取（与原 openBrowser 行为一致）。
  useEffect(() => {
    if (modelValue) void fetchDirs(initialPath || '');
    // initialPath 只在打开的那一刻取用，之后目录靠面包屑自己走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelValue]);

  return (
    <ElDialog
      modelValue={modelValue}
      onUpdateModelValue={onUpdateModelValue}
      width="520px"
      closeOnClickModal={false}
      showClose={false}
      customClass="glass-dialog"
      header={
        <div className="glass-dialog-header">
          <span className="glass-dialog-title">选择仓库目录</span>
          <button
            className="glass-dialog-close"
            type="button"
            onClick={() => onUpdateModelValue(false)}
          >
            ×
          </button>
        </div>
      }
      footer={
        <div className="glass-dialog-footer browser-footer">
          <span className="browser-selected" title={browserInfo.current}>
            {browserInfo.current}
          </span>
          <div className="browser-actions">
            <button
              className="glass-btn glass-btn-ghost"
              type="button"
              onClick={() => onUpdateModelValue(false)}
            >
              取消
            </button>
            <button className="glass-btn glass-btn-primary" type="button" onClick={confirmBrowser}>
              选择此目录
            </button>
          </div>
        </div>
      }
    >
      {/* 当前路径面包屑 */}
      <div className="browser-breadcrumb">
        {pathSegments.map((seg, i) => (
          <button
            key={i}
            className="breadcrumb-seg"
            type="button"
            title={seg.path}
            onClick={() => navigateTo(seg.path)}
          >
            {seg.label}
          </button>
        ))}
      </div>

      {/* 项目标记 */}
      {(browserInfo.isGitRepo || browserInfo.hasPackageJson) && (
        <div className="browser-badges">
          {browserInfo.isGitRepo && <span className="browser-badge git">Git</span>}
          {browserInfo.hasPackageJson && <span className="browser-badge pkg">package.json</span>}
        </div>
      )}

      {/* 目录列表 */}
      <div className={`browser-list${browserLoading ? ' is-loading' : ''}`}>
        {browserLoading ? (
          <div className="browser-empty">加载中...</div>
        ) : (
          <>
            {browserInfo.parent && (
              <button
                className="browser-item parent"
                type="button"
                onClick={() => navigateTo(browserInfo.parent!)}
              >
                ..
              </button>
            )}
            {browserInfo.dirs.map((dir) => (
              <button
                key={dir}
                className="browser-item"
                type="button"
                onClick={() => navigateTo(browserInfo.current + '/' + dir)}
              >
                <span className="dir-icon">📁</span>
                <span className="dir-name">{dir}</span>
              </button>
            ))}
            {browserInfo.dirs.length === 0 && <div className="browser-empty">无子目录</div>}
          </>
        )}
      </div>
    </ElDialog>
  );
}
