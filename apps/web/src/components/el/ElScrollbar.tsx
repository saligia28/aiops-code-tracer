/**
 * el-scrollbar 的 React 对等件。
 *
 * 原生滚动条被 EP 的 `el-scrollbar__wrap--hidden-default` 藏掉，改画自绘滑块；
 * 少了滑块就等于"看不见能滚"，所以这里把 EP 的尺寸/拖拽逻辑一并实现，
 * DOM 结构（wrap / view / bar.is-vertical > thumb）保持一致。
 *
 * wrap/view 的类名与标签可覆写：select 下拉复用同一套骨架，但它的 view 是
 * `<ul class="el-scrollbar__view el-select-dropdown__list">`。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/** 滑块最小长度：太短就没法拖了。 */
const MIN_THUMB_SIZE = 20;

export interface ElScrollbarProps {
  className?: string;
  style?: CSSProperties;
  wrapClassName?: string;
  viewClassName?: string;
  viewStyle?: CSSProperties;
  /** view 的标签名，select 下拉需要 ul。 */
  viewTag?: 'div' | 'ul';
  viewProps?: Record<string, unknown>;
  children?: ReactNode;
}

export function ElScrollbar({
  className = '',
  style,
  wrapClassName = '',
  viewClassName = '',
  viewStyle,
  viewTag = 'div',
  viewProps,
  children,
}: ElScrollbarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState({ size: 0, move: 0 });
  const [visible, setVisible] = useState(false);
  const dragging = useRef<{ startY: number; startScroll: number } | null>(null);

  const update = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { scrollHeight, clientHeight, scrollTop } = wrap;
    if (scrollHeight <= clientHeight) {
      setThumb({ size: 0, move: 0 });
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const size = Math.max(ratio * clientHeight, MIN_THUMB_SIZE);
    // 滑块可移动区间 = 轨道长 - 滑块长，按滚动进度线性映射。
    const move = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - size);
    setThumb({ size, move });
  }, []);

  useLayoutEffect(update, [update, children]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    const view = wrap.firstElementChild;
    if (view) observer.observe(view);
    return () => observer.disconnect();
  }, [update]);

  // 拖拽滑块：按轨道/内容长度比例换算成 scrollTop。
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const state = dragging.current;
      const wrap = wrapRef.current;
      if (!state || !wrap) return;
      const { scrollHeight, clientHeight } = wrap;
      const trackFree = clientHeight - thumb.size;
      if (trackFree <= 0) return;
      const delta = e.clientY - state.startY;
      wrap.scrollTop = state.startScroll + (delta / trackFree) * (scrollHeight - clientHeight);
    };
    const onUp = () => {
      dragging.current = null;
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [thumb.size]);

  const View = viewTag;

  return (
    <div
      className={`el-scrollbar ${className}`.trim()}
      style={style}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <div
        ref={wrapRef}
        className={`${wrapClassName} el-scrollbar__wrap el-scrollbar__wrap--hidden-default`.trim()}
        onScroll={update}
      >
        <View className={`el-scrollbar__view ${viewClassName}`.trim()} style={viewStyle} {...viewProps}>
          {children}
        </View>
      </div>
      <div className="el-scrollbar__bar is-horizontal" style={{ display: 'none' }}>
        <div className="el-scrollbar__thumb" style={{ transform: 'translateX(0%)' }} />
      </div>
      <div
        className="el-scrollbar__bar is-vertical"
        style={{ display: thumb.size > 0 && visible ? undefined : 'none' }}
      >
        <div
          className="el-scrollbar__thumb"
          style={{ height: thumb.size, transform: `translateY(${thumb.move}px)` }}
          onMouseDown={(e) => {
            e.preventDefault();
            const wrap = wrapRef.current;
            if (!wrap) return;
            dragging.current = { startY: e.clientY, startScroll: wrap.scrollTop };
            document.body.style.userSelect = 'none';
          }}
        />
      </div>
    </div>
  );
}
