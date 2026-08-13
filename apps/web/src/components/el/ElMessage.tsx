/**
 * ElMessage 的 React 对等件：命令式 toast。
 *
 * 用法与 EP 一致（ElMessage.success('…')），DOM/类名同样照抄
 * （.el-message--success + .el-message__icon + <p class="el-message__content">），
 * glass-dialog.css 里那条把 toast 底色钉成令牌面的覆盖才会生效。
 *
 * 多条消息按 EP 的规则从上往下堆叠：第一条 top=16，后续 = 上一条底边 + 16。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCssTransition } from './transition';
import {
  CircleCloseFilledIcon,
  InfoFilledIcon,
  SuccessFilledIcon,
  WarningFilledIcon,
} from './icons';

export type MessageType = 'success' | 'warning' | 'info' | 'error';

interface MessageItem {
  id: number;
  type: MessageType;
  content: string;
  duration: number;
}

const GAP = 16;
const DEFAULT_DURATION = 3000;

const ICONS = {
  success: SuccessFilledIcon,
  warning: WarningFilledIcon,
  info: InfoFilledIcon,
  error: CircleCloseFilledIcon,
} as const;

let seed = 0;
let push: ((item: MessageItem) => void) | null = null;
const queue: MessageItem[] = [];
let root: Root | null = null;

function ensureHost() {
  if (root) return;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<MessageHost />);
}

function MessageHost() {
  const [items, setItems] = useState<MessageItem[]>([]);
  const [offsets, setOffsets] = useState<Record<number, number>>({});
  const heights = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    push = (item) => setItems((prev) => [...prev, item]);
    // 宿主挂载前排队的消息补发出来。
    if (queue.length) {
      const pending = queue.splice(0, queue.length);
      setItems((prev) => [...prev, ...pending]);
    }
    return () => {
      push = null;
    };
  }, []);

  const measure = useCallback(
    (id: number, height: number) => {
      heights.current.set(id, height);
      setOffsets(() => {
        const next: Record<number, number> = {};
        let top = GAP;
        for (const item of items) {
          next[item.id] = top;
          top += (heights.current.get(item.id) ?? 0) + GAP;
        }
        return next;
      });
    },
    [items],
  );

  const remove = useCallback((id: number) => {
    heights.current.delete(id);
    setItems((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return (
    <>
      {items.map((item) => (
        <MessageBubble
          key={item.id}
          item={item}
          top={offsets[item.id] ?? GAP}
          onMeasure={measure}
          onClose={() => remove(item.id)}
        />
      ))}
    </>
  );
}

function MessageBubble({
  item,
  top,
  onMeasure,
  onClose,
}: {
  item: MessageItem;
  top: number;
  onMeasure: (id: number, height: number) => void;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const { mounted, transitionClass } = useCssTransition(visible, 'el-message-fade');
  const ref = useRef<HTMLDivElement | null>(null);
  /** 同 ElMessageBox：首帧 visible/mounted 都是 false，没有这个标记会被当成"已淡出"提前移除。 */
  const shown = useRef(false);
  const Icon = ICONS[item.type];

  useLayoutEffect(() => {
    setVisible(true);
    if (ref.current) onMeasure(item.id, ref.current.offsetHeight);
    // 只在首帧量一次高度：内容不会变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), item.duration);
    return () => clearTimeout(timer);
  }, [item.duration]);

  useEffect(() => {
    if (mounted) shown.current = true;
  }, [mounted]);

  useEffect(() => {
    // 离场动画播完再从列表移除。
    if (shown.current && !mounted && !visible) onClose();
  }, [mounted, visible, onClose]);

  if (!mounted) return null;

  return (
    <div
      ref={ref}
      id={`message_${item.id}`}
      className={`el-message el-message--${item.type} is-center ${transitionClass}`.trim()}
      style={{ top, zIndex: 2006 }}
      role="alert"
    >
      <Icon className={`el-message__icon el-message-icon--${item.type}`} />
      <p className="el-message__content">{item.content}</p>
    </div>
  );
}

function show(type: MessageType, content: string, duration = DEFAULT_DURATION) {
  ensureHost();
  const item: MessageItem = { id: ++seed, type, content, duration };
  if (push) push(item);
  else queue.push(item);
}

export const ElMessage = {
  success: (content: string) => show('success', content),
  warning: (content: string) => show('warning', content),
  info: (content: string) => show('info', content),
  error: (content: string) => show('error', content),
};
