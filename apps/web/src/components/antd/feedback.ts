/**
 * 全局提示（toast）的模块级出口。
 *
 * antd 推荐用 App.useApp() 拿实例，这样提示才会继承 ConfigProvider 的主题；
 * 但项目里大量调用点在事件回调、SSE 处理这类非组件代码里（迁移前是 ElMessage.xxx）。
 * 这里由 AntdProvider 在挂载时登记实例，模块侧保持同样的 `message.success(...)` 调用方式；
 * 实例就绪前的调用先入队，挂上后补发，不丢提示。
 */
import type { MessageInstance } from 'antd/es/message/interface';
import type { HookAPI as ModalHookAPI } from 'antd/es/modal/useModal';

type MessageType = 'success' | 'error' | 'warning' | 'info';

let messageApi: MessageInstance | null = null;
let modalApi: ModalHookAPI | null = null;
const pending: { type: MessageType; content: string }[] = [];

export function registerFeedback(api: { message: MessageInstance; modal: ModalHookAPI }): void {
  messageApi = api.message;
  modalApi = api.modal;
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

export function getModalApi(): ModalHookAPI | null {
  return modalApi;
}
