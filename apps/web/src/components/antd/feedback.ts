/**
 * 全局提示（toast）的模块级出口。
 *
 * 提示实例必须来自 ConfigProvider 内部（message.useMessage）才能继承主题；
 * 但项目里大量调用点在事件回调、SSE 处理这类非组件代码里（迁移前是 ElMessage.xxx）。
 * 这里由 AntdProvider 在挂载时登记实例，模块侧保持同样的 `message.success(...)` 调用方式；
 * 实例就绪前的调用先入队，挂上后补发，不丢提示。
 *
 * 只登记 message：antd 的 <App> 会把 modal + notification 也一并打进首屏包，
 * 而项目只用得到 message（确认框走 Popconfirm，输入框走自己的 prompt）。
 */
import type { MessageInstance } from 'antd/es/message/interface';

type MessageType = 'success' | 'error' | 'warning' | 'info';

let messageApi: MessageInstance | null = null;
const pending: { type: MessageType; content: string }[] = [];

export function registerFeedback(api: { message: MessageInstance }): void {
  messageApi = api.message;
  if (pending.length) {
    for (const item of pending.splice(0, pending.length)) {
      messageApi[item.type](item.content);
    }
  }
}

function show(type: MessageType, content: string): void {
  if (messageApi) messageApi[type](content);
  else pending.push({ type, content });
}

/** 与迁移前 ElMessage 同形，调用点无需关心实例从哪来。 */
export const message = {
  success: (content: string) => show('success', content),
  error: (content: string) => show('error', content),
  warning: (content: string) => show('warning', content),
  info: (content: string) => show('info', content),
};
