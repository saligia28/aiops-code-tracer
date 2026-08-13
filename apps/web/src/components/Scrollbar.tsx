/**
 * 自绘滚动条：隐藏原生滚动条，悬停时显示细滑块，可拖拽。
 *
 * antd 没有对应组件，而问答页侧栏（会话列表 / 项目记忆）依赖这种观感 ——
 * 直接用原生滚动条会在窄侧栏里压掉一条可见宽度，也和 Quiet Grid 的克制风格不符。
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
import './Scrollbar.css';

/** 滑块最小长度：太短就没法拖了。 */
const MIN_THUMB_SIZE = 20;

export interface ScrollbarProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Scrollbar({ className = '', style, children }: ScrollbarProps) {
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

  return (
    <div
      className={`qg-scrollbar ${className}`.trim()}
      style={style}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <div ref={wrapRef} className="qg-scrollbar__wrap" onScroll={update}>
        {children}
      </div>
      <div
        className="qg-scrollbar__bar"
        style={{ display: thumb.size > 0 && visible ? undefined : 'none' }}
      >
        <div
          className="qg-scrollbar__thumb"
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
