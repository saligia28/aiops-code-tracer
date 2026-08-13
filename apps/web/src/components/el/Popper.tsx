/**
 * element-plus 浮层（下拉 / 气泡）的定位与承载。
 *
 * EP 用 popper.js 定位并 teleport 到 body；这里用 portal + 一份最小定位实现替代：
 * 只覆盖项目实际用到的两种摆放（select 的 bottom-start、popconfirm 的 bottom），
 * 空间不够时上翻，并夹在视口内 —— 与 popper.js 的 flip/preventOverflow 行为一致。
 *
 * DOM 与类名（el-popper / is-light / is-pure / el-popper__arrow / data-popper-placement）
 * 完全照抄 EP，这样 vendored 的 el-popper.css 与 glass-dialog.css 里
 * `.el-popper.is-light` 那条主题兜底才能照常命中。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCssTransition } from './transition';

export type PopperPlacement = 'bottom' | 'bottom-start' | 'top' | 'top-start' | 'left' | 'right';

/** 视口边缘留白，等价 popper.js preventOverflow 的默认 padding。 */
const VIEWPORT_PADDING = 8;
/** 箭头 10px 见方，居中时要减去一半。 */
const ARROW_HALF = 5;

interface Position {
  left: number;
  top: number;
  /**
   * 左/上摆放时改钉右边、下边 —— popper.js 就是这么干的（computeStyles 的 sideX/sideY）。
   * 好处是位置只由触发元素决定，不掺入浮层自身的小数宽高，边缘落点与 EP 完全一致。
   */
  right?: number;
  bottom?: number;
  placement: PopperPlacement;
  /** 箭头沿摆放方向的横/纵偏移，指向触发元素中心。 */
  arrowLeft?: number;
  arrowTop?: number;
}

interface Size {
  width: number;
  height: number;
}

/** 按某个摆放方向算出浮层左上角（不做任何夹取）。 */
function place(placement: PopperPlacement, ref: DOMRect, f: Size, offset: number) {
  switch (placement) {
    case 'bottom-start':
      return { left: ref.left, top: ref.bottom + offset };
    case 'bottom':
      return { left: ref.left + ref.width / 2 - f.width / 2, top: ref.bottom + offset };
    case 'top-start':
      return { left: ref.left, top: ref.top - offset - f.height };
    case 'top':
      return { left: ref.left + ref.width / 2 - f.width / 2, top: ref.top - offset - f.height };
    case 'right':
      return { left: ref.right + offset, top: ref.top + ref.height / 2 - f.height / 2 };
    case 'left':
      return { left: ref.left - offset - f.width, top: ref.top + ref.height / 2 - f.height / 2 };
  }
}

/** popper.js flip 的默认 fallback 就是反向摆放（bottom↔top、left↔right）。 */
function oppositePlacement(placement: PopperPlacement): PopperPlacement {
  const map: Record<PopperPlacement, PopperPlacement> = {
    bottom: 'top',
    top: 'bottom',
    'bottom-start': 'top-start',
    'top-start': 'bottom-start',
    left: 'right',
    right: 'left',
  };
  return map[placement];
}

function fits(pos: { left: number; top: number }, f: Size): boolean {
  return (
    pos.left >= VIEWPORT_PADDING &&
    pos.top >= VIEWPORT_PADDING &&
    pos.left + f.width <= window.innerWidth - VIEWPORT_PADDING &&
    pos.top + f.height <= window.innerHeight - VIEWPORT_PADDING
  );
}

/**
 * 定位 + 翻面。等价 popper.js 的 flip：按 [主方向, ...fallback] 顺序找第一个完全放得下的，
 * 都放不下就退回主方向并夹进视口（preventOverflow）。EP 的 select 就是靠这套
 * fallback（bottom-start → top-start → right → left）在贴右边时把下拉翻到左侧。
 */
function computePosition(
  reference: DOMRect,
  floating: Size,
  placement: PopperPlacement,
  offset: number,
  fallbackPlacements: PopperPlacement[],
): Position {
  const fallbacks = fallbackPlacements.length ? fallbackPlacements : [oppositePlacement(placement)];
  const candidates: PopperPlacement[] = [placement, ...fallbacks.filter((p) => p !== placement)];
  let chosen = placement;
  let pos = place(placement, reference, floating, offset);

  for (const candidate of candidates) {
    const candidatePos = place(candidate, reference, floating, offset);
    if (fits(candidatePos, floating)) {
      chosen = candidate;
      pos = candidatePos;
      break;
    }
  }

  // 都放不下：保持主方向，夹进视口。
  let { left, top } = pos;
  if (!fits(pos, floating)) {
    const maxLeft = window.innerWidth - floating.width - VIEWPORT_PADDING;
    const maxTop = window.innerHeight - floating.height - VIEWPORT_PADDING;
    left = Math.min(Math.max(left, VIEWPORT_PADDING), Math.max(maxLeft, VIEWPORT_PADDING));
    top = Math.min(Math.max(top, VIEWPORT_PADDING), Math.max(maxTop, VIEWPORT_PADDING));
  }

  // 箭头指向触发元素中心：上下摆放走横轴，左右摆放走纵轴。
  const vertical = chosen === 'left' || chosen === 'right';
  const arrow = vertical
    ? {
        arrowTop: Math.round(
          Math.min(
            Math.max(reference.top + reference.height / 2 - top - ARROW_HALF, ARROW_HALF),
            Math.max(floating.height - ARROW_HALF * 3, ARROW_HALF),
          ),
        ),
      }
    : {
        arrowLeft: Math.round(
          Math.min(
            Math.max(reference.left + reference.width / 2 - left - ARROW_HALF, ARROW_HALF),
            Math.max(floating.width - ARROW_HALF * 3, ARROW_HALF),
          ),
        ),
      };

  // 没被夹取时（即按某个方向正常落位），左/上摆放改用 right/bottom 钉边。
  const pinned = fits(pos, floating)
    ? {
        ...(chosen === 'left' ? { right: Math.round(window.innerWidth - (reference.left - offset)) } : {}),
        ...(chosen === 'top' || chosen === 'top-start'
          ? { bottom: Math.round(window.innerHeight - (reference.top - offset)) }
          : {}),
      }
    : {};

  // popper.js 会按 devicePixelRatio 取整（roundOffsetsByDPR），不取整会差出 1px 的亚像素。
  return { left: Math.round(left), top: Math.round(top), placement: chosen, ...pinned, ...arrow };
}

export interface PopperProps {
  reference: HTMLElement | null;
  open: boolean;
  placement?: PopperPlacement;
  offset?: number;
  /** 追加到 .el-popper 上的类名（如 `el-select__popper is-pure`）。 */
  className?: string;
  /** 放不下时依次尝试的备选方向（EP select 用 bottom-start/top-start/right/left）。 */
  fallbackPlacements?: PopperPlacement[];
  /** Vue 过渡名，默认与 EP 的下拉/气泡一致。 */
  transitionName?: string;
  /** 下拉框最小宽度跟随触发元素（select 行为）。 */
  matchReferenceWidth?: boolean;
  /** 固定宽度（popconfirm 的 width 属性）。 */
  width?: number;
  /**
   * 用 transform 定位而不是 left/top。popper.js 的 gpuAcceleration 默认开启，
   * popover/popconfirm 走的就是 transform；合成层会改变文字抗锯齿方式，
   * 不跟着用的话同样的字会渲染出不同的像素。select 那条链路 EP 关掉了它，故默认 false。
   */
  useTransform?: boolean;
  showArrow?: boolean;
  id?: string;
  zIndex?: number;
  children: ReactNode;
}

export function Popper({
  reference,
  open,
  placement = 'bottom-start',
  offset = 12,
  fallbackPlacements = [],
  className = '',
  transitionName = 'el-zoom-in-top',
  matchReferenceWidth = false,
  width,
  useTransform = false,
  showArrow = true,
  id,
  zIndex = 2001,
  children,
}: PopperProps) {
  const { mounted, transitionClass } = useCssTransition(open, transitionName);
  const popperRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [referenceWidth, setReferenceWidth] = useState(0);

  const update = useCallback(() => {
    const el = popperRef.current;
    if (!el || !reference) return;
    const refRect = reference.getBoundingClientRect();
    setReferenceWidth(refRect.width);
    setPosition(
      computePosition(
        refRect,
        { width: el.offsetWidth, height: el.offsetHeight },
        placement,
        offset,
        fallbackPlacements,
      ),
    );
    // fallbackPlacements 是字面量数组，按内容而非引用参与依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, placement, offset, fallbackPlacements.join()]);

  // 布局阶段定位，避免先画在 (0,0) 再跳过去。
  useLayoutEffect(() => {
    if (!mounted) {
      setPosition(null);
      return;
    }
    update();
  }, [mounted, update, children]);

  useEffect(() => {
    if (!mounted) return;
    const onChange = () => update();
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [mounted, update]);

  if (!mounted) return null;

  const style: CSSProperties = {
    // 与 EP 一致用 absolute（body 不滚动，数值等同视口坐标）。fixed 会让 Chromium 走另一条
    // 合成路径、把文字从次像素抗锯齿降级成灰度抗锯齿，同样的字会渲染出不同的像素。
    position: 'absolute',
    zIndex,
    // 定位算出来之前先别画，免得闪一下左上角。
    visibility: position ? 'visible' : 'hidden',
    ...(useTransform
      ? { left: 0, top: 0, transform: `translate(${position?.left ?? 0}px, ${position?.top ?? 0}px)` }
      : position?.right !== undefined || position?.bottom !== undefined
        ? {
            left: position.right !== undefined ? 'auto' : position.left,
            right: position.right,
            top: position.bottom !== undefined ? 'auto' : position.top,
            bottom: position.bottom,
          }
        : { left: position?.left ?? 0, top: position?.top ?? 0 }),
  };
  if (width !== undefined) style.width = width;
  if (matchReferenceWidth && referenceWidth) style.minWidth = referenceWidth;

  return createPortal(
    <div
      ref={popperRef}
      id={id}
      className={`el-popper is-light ${className} ${transitionClass}`.replace(/\s+/g, ' ').trim()}
      style={style}
      role="tooltip"
      tabIndex={-1}
      data-popper-placement={position?.placement ?? placement}
    >
      {children}
      {showArrow && (
        <span
          className="el-popper__arrow"
          style={
            position?.arrowTop !== undefined
              ? { position: 'absolute', top: position.arrowTop }
              : { position: 'absolute', left: position?.arrowLeft ?? 0 }
          }
          data-popper-arrow=""
        />
      )}
    </div>,
    document.body,
  );
}
