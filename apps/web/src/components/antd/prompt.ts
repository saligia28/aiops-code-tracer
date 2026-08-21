/**
 * 输入型确认框的请求侧（会话重命名在用），替代迁移前的 ElMessageBox.prompt。
 *
 * 这里只有一个模块级 store 与命令式 Promise 契约：确定 resolve(value)，取消/关闭 reject ——
 * 调用方那句 `catch { return }` 才还是"取消即什么都不做"。
 *
 * 刻意不 import antd：渲染部分在 PromptHost.tsx，由 AntdProvider 按需懒加载。
 * 弹窗要用 Modal + Input（首屏包里最贵的两块），而绝大多数会话根本不会触发重命名。
 */
import { createStore } from '@/lib/store';

export interface PromptOptions {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  defaultValue?: string;
  placeholder?: string;
}

export interface PromptRequest extends PromptOptions {
  id: number;
  resolve: (value: string) => void;
  reject: () => void;
}

export const requestStore = createStore<PromptRequest | null>(null);
let seed = 0;

export function prompt(options: PromptOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    requestStore.set({ ...options, id: ++seed, resolve, reject: () => reject(new Error('cancel')) });
  });
}
