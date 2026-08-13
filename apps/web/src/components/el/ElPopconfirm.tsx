/**
 * el-popconfirm 的 React 对等件（会话/记忆的删除二次确认）。
 *
 * 触发元素由调用方作为 children 给出，这里用 cloneElement 接管 ref/onClick ——
 * 不额外包一层 DOM，触发按钮在 flex 布局里的位置与相邻选择器都不受影响
 * （EP 也是直接往触发元素上加 el-tooltip__trigger）。
 *
 * 气泡走 Popper（bottom + offset 12，与 EP popover 默认一致），内部 DOM 用
 * .el-popover > .el-popconfirm 那一套，直接吃 vendored CSS。
 */
import { cloneElement, useEffect, useState, type MouseEvent, type ReactElement } from 'react';
import { Popper } from './Popper';
import { ElButton } from './basic';
import { QuestionFilledIcon } from './icons';

export interface ElPopconfirmProps {
  title: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  confirmButtonType?: 'primary' | 'danger';
  width?: number;
  onConfirm: () => void;
  onCancel?: () => void;
  /** 触发元素（必须是单个 DOM 元素，用于挂 ref 与点击）。 */
  children: ReactElement<{
    className?: string;
    onClick?: (e: MouseEvent<HTMLElement>) => void;
    ref?: React.Ref<HTMLElement>;
  }>;
}

export function ElPopconfirm({
  title,
  confirmButtonText = '确定',
  cancelButtonText = '取消',
  confirmButtonType = 'primary',
  width = 150,
  onConfirm,
  onCancel,
  children,
}: ElPopconfirmProps) {
  const [visible, setVisible] = useState(false);
  // 用 state 而非 ref 存触发元素：拿到元素时要重新渲染一次，Popper 才能定位。
  const [reference, setReference] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!visible) return;
    // 刻意不处理 Esc：EP 的 popconfirm 按 Esc 不关（实测 2.13.3），这里保持一致。
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (reference?.contains(target)) return;
      if (target instanceof Element && target.closest('.el-popconfirm')) return;
      setVisible(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [visible, reference]);

  const trigger = cloneElement(children, {
    ref: setReference,
    className: [children.props.className, 'el-tooltip__trigger'].filter(Boolean).join(' '),
    onClick: (e: MouseEvent<HTMLElement>) => {
      children.props.onClick?.(e);
      e.stopPropagation();
      setVisible((v) => !v);
    },
  });

  return (
    <>
      {trigger}
      <Popper
        reference={reference}
        open={visible}
        placement="bottom"
        offset={12}
        width={Math.max(width, 150)}
        useTransform
        className="el-tooltip el-popover"
        transitionName="el-fade-in-linear"
      >
        <div tabIndex={-1} className="el-popconfirm">
          <div className="el-popconfirm__main">
            <QuestionFilledIcon
              className="el-popconfirm__icon"
              style={{ color: 'rgb(255, 153, 0)' }}
            />
            {` ${title}`}
          </div>
          <div className="el-popconfirm__action">
            <ElButton
              size="small"
              text
              onClick={() => {
                setVisible(false);
                onCancel?.();
              }}
            >
              {cancelButtonText}
            </ElButton>
            <ElButton
              size="small"
              type={confirmButtonType}
              onClick={() => {
                setVisible(false);
                onConfirm();
              }}
            >
              {confirmButtonText}
            </ElButton>
          </div>
        </div>
      </Popper>
    </>
  );
}
