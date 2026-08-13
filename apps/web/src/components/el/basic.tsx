/**
 * 结构简单、无交互状态的 element-plus 组件对等件：
 * button / tag / card / descriptions / progress / empty / input。
 *
 * 全部按 EP 渲染结果 1:1 复刻 DOM 与类名（含 `<span class="">` 这类细节），
 * 保证 vendored 的 theme-chalk 子集与 quiet-grid.css 里的 `.el-tag--success` 等
 * 覆盖规则原样命中。
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { CircleCheckIcon, LoadingIcon } from './icons';

// ============================================================
// el-button
// ============================================================
export interface ElButtonProps {
  type?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  loading?: boolean;
  disabled?: boolean;
  size?: 'large' | 'default' | 'small';
  text?: boolean;
  className?: string;
  onClick?: () => void;
  children?: ReactNode;
}

export function ElButton({
  type,
  loading = false,
  disabled = false,
  size = 'default',
  text = false,
  className = '',
  onClick,
  children,
}: ElButtonProps) {
  const isDisabled = disabled || loading;
  const classes = [
    'el-button',
    type ? `el-button--${type}` : '',
    size !== 'default' ? `el-button--${size}` : '',
    text ? 'is-text' : '',
    loading ? 'is-loading' : '',
    disabled ? 'is-disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      aria-disabled={isDisabled}
      disabled={isDisabled}
      type="button"
      className={classes}
      onClick={onClick}
    >
      {loading && <LoadingIcon />}
      <span className="">{children}</span>
    </button>
  );
}

// ============================================================
// el-tag
// ============================================================
export function ElTag({
  type,
  children,
}: {
  type?: 'success' | 'warning' | 'danger' | 'info' | 'primary';
  children?: ReactNode;
}) {
  return (
    <span className={`el-tag${type ? ` el-tag--${type}` : ''} el-tag--light`}>
      <span className="el-tag__content">{children}</span>
    </span>
  );
}

// ============================================================
// el-card
// ============================================================
export function ElCard({
  className = '',
  header,
  children,
}: {
  className?: string;
  header?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`el-card is-always-shadow ${className}`.trim()}>
      {header !== undefined && <div className="el-card__header">{header}</div>}
      <div className="el-card__body">{children}</div>
    </div>
  );
}

// ============================================================
// el-descriptions
// ============================================================
export interface DescriptionItem {
  label: ReactNode;
  content: ReactNode;
}

export function ElDescriptions({
  column = 3,
  border = false,
  items,
}: {
  column?: number;
  border?: boolean;
  items: DescriptionItem[];
}) {
  // 按 column 切行；行内最后一格补齐剩余列宽（与 EP 的 filledNode 同口径）。
  const rows: DescriptionItem[][] = [];
  for (let i = 0; i < items.length; i += column) rows.push(items.slice(i, i + column));

  return (
    <div className="el-descriptions">
      <div className="el-descriptions__body">
        <table className={`el-descriptions__table${border ? ' is-bordered' : ''}`}>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((item, index) => (
                  <ElDescriptionsCell
                    key={index}
                    item={item}
                    border={border}
                    contentColSpan={index === row.length - 1 ? (column - index) * 2 - 1 : 1}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ElDescriptionsCell({
  item,
  border,
  contentColSpan,
}: {
  item: DescriptionItem;
  border: boolean;
  contentColSpan: number;
}) {
  return (
    <>
      <td
        className={`el-descriptions__cell el-descriptions__label${border ? ' is-bordered-label' : ''}`}
        colSpan={1}
      >
        {item.label}
      </td>
      <td
        className={`el-descriptions__cell el-descriptions__content${
          border ? ' is-bordered-content' : ''
        }`}
        colSpan={contentColSpan}
      >
        {item.content}
      </td>
    </>
  );
}

// ============================================================
// el-progress（线形）
// ============================================================
export function ElProgress({
  percentage,
  status,
  strokeWidth = 6,
}: {
  percentage: number;
  status?: 'success' | 'exception' | 'warning';
  strokeWidth?: number;
}) {
  return (
    <div
      className={`el-progress el-progress--line${status ? ` is-${status}` : ''}`}
      role="progressbar"
      aria-valuenow={percentage}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="el-progress-bar">
        <div className="el-progress-bar__outer" style={{ height: strokeWidth }}>
          <div
            className="el-progress-bar__inner"
            style={{ width: `${percentage}%`, animationDuration: '3s' }}
          />
        </div>
      </div>
      <div className="el-progress__text" style={{ fontSize: 14.4 }}>
        {status === 'success' ? <CircleCheckIcon /> : <span>{percentage}%</span>}
      </div>
    </div>
  );
}

// ============================================================
// el-input（单行文本）
// ============================================================
export function ElInput({
  modelValue,
  onChange,
  placeholder,
  className = '',
  style,
  disabled = false,
  type = 'text',
  inputRef,
  onKeyDown,
}: {
  modelValue: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  type?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  // EP 聚焦时给 wrapper 加 is-focus（焦点描边挂在 wrapper 上，不是 input 上）。
  const [focused, setFocused] = useState(false);

  return (
    <div className={`el-input ${className}`.trim()} style={style}>
      <div className={`el-input__wrapper${focused ? ' is-focus' : ''}`} tabIndex={-1}>
        <input
          ref={inputRef}
          className="el-input__inner"
          type={type}
          autoComplete="off"
          tabIndex={0}
          placeholder={placeholder}
          disabled={disabled}
          value={modelValue}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
    </div>
  );
}

// ============================================================
// el-empty
// ============================================================
export function ElEmpty({ description }: { description?: string }) {
  // SVG 内部 id 必须每个实例唯一，否则同页多个 empty 的渐变会互相串。
  const uid = useId().replace(/:/g, '');
  const grad1 = `linearGradient-1-${uid}`;
  const grad2 = `linearGradient-2-${uid}`;
  const path3 = `path-3-${uid}`;
  const mask4 = `mask-4-${uid}`;

  return (
    <div className="el-empty">
      <div className="el-empty__image">
        <svg viewBox="0 0 79 86" version="1.1" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id={grad1} x1="38.8503086%" y1="0%" x2="61.1496914%" y2="100%">
              <stop stopColor="var(--el-empty-fill-color-1)" offset="0%" />
              <stop stopColor="var(--el-empty-fill-color-4)" offset="100%" />
            </linearGradient>
            <linearGradient id={grad2} x1="0%" y1="9.5%" x2="100%" y2="90.5%">
              <stop stopColor="var(--el-empty-fill-color-1)" offset="0%" />
              <stop stopColor="var(--el-empty-fill-color-6)" offset="100%" />
            </linearGradient>
            <rect id={path3} x="0" y="0" width="17" height="36" />
          </defs>
          <g stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
            <g transform="translate(-1268.000000, -535.000000)">
              <g transform="translate(1268.000000, 535.000000)">
                <path
                  d="M39.5,86 C61.3152476,86 79,83.9106622 79,81.3333333 C79,78.7560045 57.3152476,78 35.5,78 C13.6847524,78 0,78.7560045 0,81.3333333 C0,83.9106622 17.6847524,86 39.5,86 Z"
                  fill="var(--el-empty-fill-color-3)"
                />
                <polygon
                  fill="var(--el-empty-fill-color-7)"
                  transform="translate(27.500000, 51.500000) scale(1, -1) translate(-27.500000, -51.500000) "
                  points="13 58 53 58 42 45 2 45"
                />
                <g transform="translate(34.500000, 31.500000) scale(-1, 1) rotate(-25.000000) translate(-34.500000, -31.500000) translate(7.000000, 10.000000)">
                  <polygon
                    fill="var(--el-empty-fill-color-7)"
                    transform="translate(11.500000, 5.000000) scale(1, -1) translate(-11.500000, -5.000000) "
                    points="2.84078316e-14 3 18 3 23 7 5 7"
                  />
                  <polygon
                    fill="var(--el-empty-fill-color-5)"
                    points="-3.69149156e-15 7 38 7 38 43 -3.69149156e-15 43"
                  />
                  <rect
                    fill={`url(#${grad1})`}
                    transform="translate(46.500000, 25.000000) scale(-1, 1) translate(-46.500000, -25.000000) "
                    x="38"
                    y="7"
                    width="17"
                    height="36"
                  />
                  <polygon
                    fill="var(--el-empty-fill-color-2)"
                    transform="translate(39.500000, 3.500000) scale(-1, 1) translate(-39.500000, -3.500000) "
                    points="24 7 41 7 55 -3.63806207e-12 38 -3.63806207e-12"
                  />
                </g>
                <rect fill={`url(#${grad2})`} x="13" y="45" width="40" height="36" />
                <g transform="translate(53.000000, 45.000000)">
                  <use
                    fill="var(--el-empty-fill-color-8)"
                    transform="translate(8.500000, 18.000000) scale(-1, 1) translate(-8.500000, -18.000000) "
                    xlinkHref={`#${path3}`}
                  />
                  <polygon
                    fill="var(--el-empty-fill-color-9)"
                    mask={`url(#${mask4})`}
                    transform="translate(12.000000, 9.000000) scale(-1, 1) translate(-12.000000, -9.000000) "
                    points="7 0 24 0 20 18 7 16.5"
                  />
                </g>
                <polygon
                  fill="var(--el-empty-fill-color-2)"
                  transform="translate(66.000000, 51.500000) scale(-1, 1) translate(-66.000000, -51.500000) "
                  points="62 45 79 45 70 58 53 58"
                />
              </g>
            </g>
          </g>
        </svg>
      </div>
      {description !== undefined && (
        <div className="el-empty__description">
          <p>{description}</p>
        </div>
      )}
    </div>
  );
}
