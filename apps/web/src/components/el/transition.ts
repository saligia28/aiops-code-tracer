/**
 * Vue `<Transition>` 的最小 React 对等件。
 *
 * 为什么要有：迁移后我们复用 element-plus 原版 CSS，而那些 CSS 里的进出场效果
 * （dialog-fade / el-message-fade / el-zoom-in-top）全部按 Vue 过渡类名写死 ——
 * `<name>-enter-from` → `<name>-enter-active` → `<name>-enter-to`。这里把同一套类名
 * 按同样的时序打上去，弹窗/提示/下拉的动效才和迁移前一致。
 *
 * 结束时机用定时器而非 transitionend：EP 的对话框走的是 @keyframes 动画，
 * transitionend 根本不会触发。
 */
import { useEffect, useRef, useState } from 'react';

/** 与 --el-transition-duration (0.3s) 对齐，留一点余量兜底。 */
const DEFAULT_DURATION = 400;

export interface TransitionState {
  /** 是否应该出现在 DOM 中（离场动画播完才变 false）。 */
  mounted: boolean;
  /** 当前该挂到元素上的过渡类名。 */
  transitionClass: string;
}

export function useCssTransition(
  show: boolean,
  name: string,
  duration = DEFAULT_DURATION,
): TransitionState {
  const [mounted, setMounted] = useState(show);
  const [transitionClass, setTransitionClass] = useState('');
  const mountedRef = useRef(show);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const first = useRef(true);

  mountedRef.current = mounted;

  useEffect(() => {
    // 首帧就可见时不播入场动画（与 Vue 默认 appear=false 一致）。
    if (first.current) {
      first.current = false;
      if (show) return;
    }

    const clear = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      timer.current = null;
      frame.current = null;
    };
    clear();

    if (show) {
      setMounted(true);
      setTransitionClass(`${name}-enter-from ${name}-enter-active`);
      // 两帧：第一帧让 enter-from 生效，第二帧切到 enter-to 才会真正过渡。
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          setTransitionClass(`${name}-enter-active ${name}-enter-to`);
          timer.current = setTimeout(() => setTransitionClass(''), duration);
        });
      });
    } else if (mountedRef.current) {
      setTransitionClass(`${name}-leave-from ${name}-leave-active`);
      frame.current = requestAnimationFrame(() => {
        frame.current = requestAnimationFrame(() => {
          setTransitionClass(`${name}-leave-active ${name}-leave-to`);
          timer.current = setTimeout(() => {
            setMounted(false);
            setTransitionClass('');
          }, duration);
        });
      });
    }

    return clear;
  }, [show, name, duration]);

  return { mounted, transitionClass };
}
