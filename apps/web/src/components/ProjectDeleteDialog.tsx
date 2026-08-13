import { useEffect, useState } from 'react';
import { Modal } from 'antd';
import { message } from '@/components/antd/feedback';
import { useProject } from '@/hooks/useProject';

export interface DeleteTarget {
  id: string;
  name: string;
  risks: string[];
}

export interface ProjectDeleteDialogProps {
  modelValue: boolean;
  onUpdateModelValue: (value: boolean) => void;
  /** 由父级在打开前填好（含已查询的关联风险）。 */
  target: DeleteTarget;
  onDeleted?: () => void;
}

export function ProjectDeleteDialog({
  modelValue,
  onUpdateModelValue,
  target,
  onDeleted,
}: ProjectDeleteDialogProps) {
  const { deleteProject } = useProject();
  const [deleting, setDeleting] = useState(false);
  const [deleteData, setDeleteData] = useState(false);

  // 每次打开时重置「删除数据」勾选（与原 handleDeleteCheck 行为一致）。
  useEffect(() => {
    if (modelValue) setDeleteData(false);
  }, [modelValue]);

  async function confirmDelete() {
    setDeleting(true);
    try {
      await deleteProject(target.id, deleteData);
      message.success(`项目「${target.name}」已删除`);
      onUpdateModelValue(false);
      onDeleted?.();
    } catch {
      message.error('删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open={modelValue}
      onCancel={() => onUpdateModelValue(false)}
      width={420}
      mask={{ closable: false }}
      closable={false}
      className="glass-dialog glass-dialog-danger"
      destroyOnHidden
      title={
        <div className="glass-dialog-header">
          <span className="glass-dialog-title">删除项目</span>
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
            className="glass-btn glass-btn-danger"
            type="button"
            disabled={deleting}
            onClick={confirmDelete}
          >
            {deleting ? '删除中...' : '确认删除'}
          </button>
        </div>
      }
    >
      <p className="glass-dialog-body-text">
        确定要删除项目「<strong>{target.name}</strong>」吗？
      </p>
      {target.risks.length > 0 && (
        <div className="delete-risks">
          <div className="risk-title">风险提示</div>
          <ul className="risk-list">
            {target.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="glass-checkbox">
        <input
          type="checkbox"
          checked={deleteData}
          onChange={(e) => setDeleteData(e.target.checked)}
        />
        <span>同时删除图谱数据（不可恢复）</span>
      </label>
    </Modal>
  );
}
