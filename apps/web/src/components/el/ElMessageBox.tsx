/**
 * ElMessageBox.prompt 的 React 对等件（会话重命名在用）。
 *
 * 与 EP 同样是命令式 + Promise：确定 resolve({ value })，取消/关闭 reject —— 调用方
 * 那句 `catch { return }` 才还是"取消即什么都不做"。DOM 用 EP 的
 * .el-overlay.is-message-box > .el-overlay-message-box > .el-message-box 结构。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useCssTransition } from './transition';
import { CloseIcon } from './icons';

export interface PromptOptions {
  confirmButtonText?: string;
  cancelButtonText?: string;
  inputValue?: string;
  inputPlaceholder?: string;
}

export interface PromptResult {
  value: string;
}

function PromptBox({
  message,
  title,
  options,
  onDone,
}: {
  message: string;
  title: string;
  options: PromptOptions;
  onDone: (result: PromptResult | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(options.inputValue ?? '');
  // EP 打开时自动聚焦输入框，wrapper 会带上 is-focus 的描边。
  const [inputFocused, setInputFocused] = useState(false);
  const { mounted, transitionClass } = useCssTransition(open, 'fade-in-linear');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const result = useRef<PromptResult | null>(null);
  /** 是否真的开过。首帧 open/mounted 都是 false，没有这个标记会立刻当成"已关闭"把 Promise 兑现掉。 */
  const opened = useRef(false);

  useEffect(() => {
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    opened.current = true;
    // 等入场那一帧真正挂上 DOM 再聚焦：首帧 mounted 还是 false，inputRef 是空的。
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [mounted]);

  // 离场动画播完再兑现 Promise，避免弹窗还在淡出就被卸载。
  useEffect(() => {
    if (opened.current && !mounted && !open) onDone(result.current);
  }, [mounted, open, onDone]);

  function finish(payload: PromptResult | null) {
    result.current = payload;
    setOpen(false);
  }

  if (!mounted) return null;

  return (
    <div className={`el-overlay is-message-box ${transitionClass}`.trim()} style={{ zIndex: 2008 }}>
      <div role="dialog" aria-modal="true" className="el-overlay-message-box" aria-label={title}>
        <div className="el-message-box" tabIndex={-1}>
          <div className="el-message-box__header show-close">
            <div className="el-message-box__title">
              <span>{title}</span>
            </div>
            <button
              type="button"
              className="el-message-box__headerbtn"
              aria-label="Close this dialog"
              onClick={() => finish(null)}
            >
              <CloseIcon className="el-message-box__close" />
            </button>
          </div>
          <div className="el-message-box__content">
            <div className="el-message-box__container">
              <div className="el-message-box__message">
                <label>{message}</label>
              </div>
            </div>
            <div className="el-message-box__input">
              <div className="el-input">
                <div className={`el-input__wrapper${inputFocused ? ' is-focus' : ''}`}>
                  <input
                    ref={inputRef}
                    className="el-input__inner"
                    type="text"
                    autoComplete="off"
                    tabIndex={0}
                    placeholder={options.inputPlaceholder}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onFocus={() => setInputFocused(true)}
                    onBlur={() => setInputFocused(false)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finish({ value });
                    }}
                  />
                </div>
              </div>
              <div className="el-message-box__errormsg" style={{ visibility: 'hidden' }} />
            </div>
          </div>
          <div className="el-message-box__btns">
            <button type="button" className="el-button" onClick={() => finish(null)}>
              <span className="">{options.cancelButtonText ?? '取消'}</span>
            </button>
            <button
              type="button"
              className="el-button el-button--primary"
              onClick={() => finish({ value })}
            >
              <span className="">{options.confirmButtonText ?? '确定'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function prompt(message: string, title: string, options: PromptOptions = {}): Promise<PromptResult> {
  return new Promise((resolve, reject) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const done = (result: PromptResult | null) => {
      // 卸载必须异步：正处在 React 渲染流程中同步 unmount 会告警。
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 0);
      if (result) resolve(result);
      else reject(new Error('cancel'));
    };

    root.render(<PromptBox message={message} title={title} options={options} onDone={done} />);
  });
}

export const ElMessageBox = { prompt };
