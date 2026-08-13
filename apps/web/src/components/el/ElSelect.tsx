/**
 * el-select 的 React 对等件（单选）。覆盖项目实际用到的能力：
 * size=small、filterable + allow-create + default-first-option（模型选择器要能填新模型名）、
 * clearable、disabled、popper-class。
 *
 * DOM/类名（el-select__wrapper、is-focused/is-hovering/is-filterable、
 * el-select__placeholder.is-transparent、el-select__caret.is-reverse、
 * el-select-dropdown__item.is-selected/is-hovering）与 EP 一致，直接吃 vendored CSS。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Popper, type PopperPlacement } from './Popper';
import { ElScrollbar } from './ElScrollbar';
import { ArrowDownIcon, CircleCloseIcon } from './icons';

/** 与 EP select 的 fallback-placements 默认值一致：贴右边时下拉会翻到左侧。 */
const SELECT_FALLBACK_PLACEMENTS: PopperPlacement[] = ['bottom-start', 'top-start', 'right', 'left'];

export interface ElSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ElSelectProps {
  modelValue: string;
  options: ElSelectOption[];
  onChange?: (value: string) => void;
  placeholder?: string;
  size?: 'large' | 'default' | 'small';
  disabled?: boolean;
  filterable?: boolean;
  allowCreate?: boolean;
  defaultFirstOption?: boolean;
  clearable?: boolean;
  className?: string;
  style?: CSSProperties;
  popperClass?: string;
}

export function ElSelect({
  modelValue,
  options,
  onChange,
  placeholder = '',
  size = 'default',
  disabled = false,
  filterable = false,
  allowCreate = false,
  defaultFirstOption = false,
  clearable = false,
  className = '',
  style,
  popperClass = '',
}: ElSelectProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [hovering, setHovering] = useState(false);
  const [hoverIndex, setHoverIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === modelValue)?.label ?? modelValue,
    [options, modelValue],
  );

  // allow-create：输入的内容不在候选里时，置顶一条"新建"项，回车即可选中。
  const visibleOptions = useMemo(() => {
    const q = query.trim();
    if (!filterable || !q) return options;
    const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
    if (allowCreate && !options.some((o) => o.value === q)) {
      return [{ value: q, label: q }, ...filtered];
    }
    return filtered;
  }, [options, query, filterable, allowCreate]);

  useEffect(() => {
    if (!expanded) return;
    setHoverIndex(() => {
      const idx = visibleOptions.findIndex((o) => o.value === modelValue);
      return idx >= 0 ? idx : defaultFirstOption ? 0 : -1;
    });
    // 只在展开的那一刻定位高亮项，之后交给键盘/筛选逻辑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !filterable) return;
    setHoverIndex(defaultFirstOption ? 0 : -1);
  }, [query, expanded, filterable, defaultFirstOption]);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.el-select__popper')) return;
      close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  function close() {
    setExpanded(false);
    setQuery('');
  }

  function pick(option: ElSelectOption) {
    if (option.disabled) return;
    close();
    if (option.value !== modelValue) onChange?.(option.value);
  }

  function toggle() {
    if (disabled) return;
    if (expanded) {
      close();
    } else {
      setExpanded(true);
      if (filterable) requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!expanded) {
        setExpanded(true);
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHoverIndex((i) => {
        const next = i + step;
        if (next < 0) return visibleOptions.length - 1;
        if (next >= visibleOptions.length) return 0;
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!expanded) {
        setExpanded(true);
        return;
      }
      const option = visibleOptions[hoverIndex];
      if (option) pick(option);
    } else if (e.key === 'Escape') {
      close();
    }
  }

  const sizeClass = size !== 'default' ? ` el-select--${size}` : '';
  const inputSizeClass = size !== 'default' ? ` is-${size}` : '';
  const showClear = clearable && hovering && !disabled && Boolean(modelValue);
  const filtering = filterable && expanded;
  // 有值时展示所选项；筛选态与空值态都按"占位"的浅色处理。
  const displayText = selectedLabel || placeholder;

  return (
    <div ref={rootRef} className={`el-select${sizeClass} ${className}`.trim()} style={style}>
      <div
        ref={wrapperRef}
        className={[
          'el-select__wrapper',
          'el-tooltip__trigger',
          filterable ? 'is-filterable' : '',
          expanded ? 'is-focused' : '',
          hovering && !expanded ? 'is-hovering' : '',
          disabled ? 'is-disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        tabIndex={-1}
        onClick={toggle}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="el-select__selection">
          <div
            className={`el-select__selected-item el-select__input-wrapper${filtering ? '' : ' is-hidden'}`}
          >
            <input
              ref={inputRef}
              type="text"
              className={`el-select__input${inputSizeClass}`}
              autoComplete="off"
              tabIndex={0}
              role="combobox"
              readOnly={!filterable}
              spellCheck={false}
              aria-expanded={expanded}
              aria-haspopup="listbox"
              aria-autocomplete="none"
              disabled={disabled}
              value={filtering ? query : ''}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {filterable && <span aria-hidden="true" className="el-select__input-calculator" />}
          </div>
          <div
            className={`el-select__selected-item el-select__placeholder${
              !modelValue || (filtering && query) ? ' is-transparent' : ''
            }`}
          >
            <span>{filtering && query ? '' : displayText}</span>
          </div>
        </div>
        <div className="el-select__suffix">
          {showClear ? (
            <CircleCloseIcon
              className="el-select__caret el-select__icon el-select__clear"
              onClick={(e) => {
                e.stopPropagation();
                onChange?.('');
              }}
            />
          ) : (
            <ArrowDownIcon
              className={`el-select__caret el-select__icon${expanded ? ' is-reverse' : ''}`}
            />
          )}
        </div>
      </div>

      <Popper
        reference={wrapperRef.current}
        open={expanded}
        placement="bottom-start"
        offset={12}
        fallbackPlacements={SELECT_FALLBACK_PLACEMENTS}
        matchReferenceWidth
        className={`is-pure el-tooltip el-select__popper ${popperClass}`.trim()}
      >
        <div className={`el-select-dropdown ${popperClass}`.trim()}>
          {visibleOptions.length === 0 ? (
            <div className="el-select-dropdown__empty">无数据</div>
          ) : (
            <ElScrollbar
              wrapClassName="el-select-dropdown__wrap"
              viewClassName="el-select-dropdown__list"
              viewTag="ul"
              viewProps={{ role: 'listbox', 'aria-orientation': 'vertical' }}
            >
              {visibleOptions.map((option, index) => (
                <li
                  key={option.value}
                  className={[
                    'el-select-dropdown__item',
                    option.value === modelValue ? 'is-selected' : '',
                    index === hoverIndex ? 'is-hovering' : '',
                    option.disabled ? 'is-disabled' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  role="option"
                  aria-selected={option.value === modelValue}
                  onMouseEnter={() => setHoverIndex(index)}
                  onClick={(e) => {
                    e.stopPropagation();
                    pick(option);
                  }}
                >
                  <span>{option.label}</span>
                </li>
              ))}
            </ElScrollbar>
          )}
        </div>
      </Popper>
    </div>
  );
}
