import { useEffect, useRef, useState } from 'react';
import { ElDialog, ElMessage } from '@/components/el';
import { useProject, FRAMEWORK_OPTIONS } from '@/hooks/useProject';
import type { ProjectFramework } from '@/hooks/useProject';
import { DirectoryBrowser } from './DirectoryBrowser';

// 各框架的默认扫描路径，需与后端 preset（@aiops/parser presets.ts）保持一致；
// web 不依赖 @aiops/parser，故在此内联一份最小映射。
const FRAMEWORK_DEFAULT_SCAN_PATHS: Partial<Record<ProjectFramework, string>> = {
  // 整仓扫描，兼容单模块与多模块（<module>/src/main/java）布局；与后端 preset 一致
  java: '.',
};

function defaultScanPathsFor(fw: ProjectFramework): string {
  return FRAMEWORK_DEFAULT_SCAN_PATHS[fw] ?? 'src';
}

export interface ProjectCreateDialogProps {
  modelValue: boolean;
  onUpdateModelValue: (value: boolean) => void;
  /** 创建成功后通知父级（父级已通过共享的 useProject 状态自动刷新，可选监听）。 */
  onCreated?: () => void;
}

export function ProjectCreateDialog({
  modelValue,
  onUpdateModelValue,
  onCreated,
}: ProjectCreateDialogProps) {
  const { createProject, switchProject } = useProject();

  const [creating, setCreating] = useState(false);
  const [browserVisible, setBrowserVisible] = useState(false);

  const [name, setName] = useState('');
  const [framework, setFramework] = useState<ProjectFramework>('vue3');
  const [repoPath, setRepoPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [scanPathsStr, setScanPathsStr] = useState('src');

  // 用户是否手动编辑过扫描路径；未编辑时随 framework 切换同步默认值，编辑后用户输入优先。
  const scanPathsTouched = useRef(false);
  const firstRender = useRef(true);

  useEffect(() => {
    // 与 Vue watch 一致：只在 framework 变化时同步，首帧不动。
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!scanPathsTouched.current) setScanPathsStr(defaultScanPathsFor(framework));
  }, [framework]);

  function openBrowser() {
    setBrowserVisible(true);
  }

  function resetForm() {
    setName('');
    setFramework('vue3');
    setRepoPath('');
    setGitUrl('');
    setScanPathsStr(defaultScanPathsFor('vue3'));
    scanPathsTouched.current = false;
  }

  async function handleCreate() {
    if (!name.trim()) {
      ElMessage.warning('请输入项目名称');
      return;
    }
    if (!repoPath.trim()) {
      ElMessage.warning('请选择本地仓库路径');
      return;
    }

    setCreating(true);
    try {
      const scanPaths = scanPathsStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const record = await createProject({
        name: name.trim(),
        framework,
        repoPath: repoPath.trim(),
        gitUrl: gitUrl.trim(),
        scanPaths,
      });

      ElMessage.success(`项目 "${record.name}" 创建成功`);
      onUpdateModelValue(false);
      resetForm();

      await switchProject(record.id);
      onCreated?.();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        '创建失败';
      ElMessage.error(msg);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <ElDialog
        modelValue={modelValue}
        onUpdateModelValue={onUpdateModelValue}
        width="460px"
        closeOnClickModal={false}
        showClose={false}
        customClass="glass-dialog"
        header={
          <div className="glass-dialog-header">
            <span className="glass-dialog-title">新建项目</span>
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
          <div className="glass-dialog-footer">
            <button
              className="glass-btn glass-btn-ghost"
              type="button"
              onClick={() => onUpdateModelValue(false)}
            >
              取消
            </button>
            <button
              className="glass-btn glass-btn-primary"
              type="button"
              disabled={creating}
              onClick={handleCreate}
            >
              {creating ? '创建中...' : '确认创建'}
            </button>
          </div>
        }
      >
        <div className="glass-form">
          <label className="glass-label">
            <span className="glass-label-text">
              项目名称 <em>*</em>
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="glass-input"
              placeholder="例如 my-project"
            />
          </label>
          <label className="glass-label">
            <span className="glass-label-text">
              语言 / 框架 <em>*</em>
            </span>
            <select
              value={framework}
              onChange={(e) => setFramework(e.target.value as ProjectFramework)}
              className="glass-input glass-select"
            >
              {FRAMEWORK_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="glass-label">
            <span className="glass-label-text">
              仓库路径 <em>*</em>
            </span>
            <div className="glass-input-row">
              <input
                value={repoPath}
                className="glass-input"
                placeholder="/Users/.../your-project"
                readOnly
                onClick={openBrowser}
              />
              <button className="glass-btn-outline" type="button" onClick={openBrowser}>
                浏览
              </button>
            </div>
          </label>
          <label className="glass-label">
            <span className="glass-label-text">
              Git 地址 <span className="glass-label-hint">(预留)</span>
            </span>
            <input
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              className="glass-input"
              placeholder="https://github.com/..."
            />
          </label>
          <label className="glass-label">
            <span className="glass-label-text">扫描路径</span>
            <input
              value={scanPathsStr}
              className="glass-input"
              placeholder="src（多个用逗号分隔）"
              onChange={(e) => {
                scanPathsTouched.current = true;
                setScanPathsStr(e.target.value);
              }}
            />
          </label>
        </div>
      </ElDialog>

      {/* 目录浏览弹窗 */}
      <DirectoryBrowser
        modelValue={browserVisible}
        onUpdateModelValue={setBrowserVisible}
        initialPath={repoPath}
        onSelect={setRepoPath}
      />
    </>
  );
}
