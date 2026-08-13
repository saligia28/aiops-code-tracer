/**
 * el-dialog 的 React 对等件（只实现项目用到的那部分：自定义 header/footer、
 * 固定宽度、closeOnClickModal、showClose）。
 *
 * DOM 层级与类名照抄 EP：.el-overlay.el-modal-dialog > .el-overlay-dialog > .el-dialog，
 * 宽度同样走 `--el-dialog-width` 内联变量 —— glass-dialog.css 里
 * `.glass-dialog.el-dialog` / `.glass-dialog .el-dialog__header` 那一套皮肤才能原样生效。
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCssTransition } from './transition';
import { CloseIcon } from './icons';

export interface ElDialogProps {
  modelValue: boolean;
  onUpdateModelValue: (value: boolean) => void;
  width?: string;
  closeOnClickModal?: boolean;
  showClose?: boolean;
  /** 等价 EP 的 custom-class：直接挂到 .el-dialog 上。 */
  customClass?: string;
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}

let openDialogCount = 0;

export function ElDialog({
  modelValue,
  onUpdateModelValue,
  width = '50%',
  closeOnClickModal = true,
  showClose = true,
  customClass = '',
  header,
  footer,
  children,
}: ElDialogProps) {
  const { mounted, transitionClass } = useCssTransition(modelValue, 'dialog-fade');

  // EP 打开弹窗时给 body 挂 el-popup-parent--hidden 锁滚动；多个弹窗叠加时按计数还原。
  useEffect(() => {
    if (!modelValue) return;
    openDialogCount += 1;
    document.body.classList.add('el-popup-parent--hidden');
    return () => {
      openDialogCount -= 1;
      if (openDialogCount <= 0) {
        openDialogCount = 0;
        document.body.classList.remove('el-popup-parent--hidden');
      }
    };
  }, [modelValue]);

  useEffect(() => {
    if (!modelValue) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onUpdateModelValue(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [modelValue, onUpdateModelValue]);

  if (!mounted) return null;

  return createPortal(
    <div className={`el-overlay el-modal-dialog ${transitionClass}`.trim()} style={{ zIndex: 2001 }}>
      <div
        role="dialog"
        aria-modal="true"
        className="el-overlay-dialog"
        onClick={(e) => {
          if (closeOnClickModal && e.target === e.currentTarget) onUpdateModelValue(false);
        }}
      >
        <div
          className={`el-dialog ${customClass}`.trim()}
          style={{ ['--el-dialog-width' as string]: width }}
          tabIndex={-1}
        >
          <header className={`el-dialog__header${showClose ? ' show-close' : ''}`}>{header}</header>
          {showClose && (
            <button
              type="button"
              aria-label="Close"
              className="el-dialog__headerbtn"
              onClick={() => onUpdateModelValue(false)}
            >
              <CloseIcon className="el-dialog__close" />
            </button>
          )}
          <div className="el-dialog__body">{children}</div>
          {footer !== undefined && <footer className="el-dialog__footer">{footer}</footer>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
