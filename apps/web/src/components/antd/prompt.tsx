/**
 * 输入型确认框（会话重命名在用），替代迁移前的 ElMessageBox.prompt。
 *
 * antd 的 Modal.confirm 没有输入框，这里用 Modal + Input 自己拼一个，并保持
 * 同样的命令式 Promise 契约：确定 resolve({ value })，取消/关闭 reject ——
 * 调用方那句 `catch { return }` 才还是"取消即什么都不做"。
 *
 * 宿主 <PromptHost /> 挂在 AntdProvider 内部，所以弹窗能继承主题；
 * 请求本身走模块级 store，非组件代码也能直接 await prompt(...)。
 */
import { Input, Modal } from 'antd';
import type { InputRef } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from '@/lib/store';

export interface PromptOptions {
  title: string;
  message: string;
  okText?: string;
  cancelText?: string;
  defaultValue?: string;
  placeholder?: string;
}

interface PromptRequest extends PromptOptions {
  id: number;
  resolve: (value: string) => void;
  reject: () => void;
}

const requestStore = createStore<PromptRequest | null>(null);
let seed = 0;

export function prompt(options: PromptOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    requestStore.set({ ...options, id: ++seed, resolve, reject: () => reject(new Error('cancel')) });
  });
}

export function PromptHost() {
  const request = useStore(requestStore);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<InputRef>(null);
  // 关闭动画播完才兑现 Promise，避免弹窗还在淡出就被卸载。
  const settled = useRef<{ ok: boolean; value: string } | null>(null);

  useEffect(() => {
    if (!request) return;
    setValue(request.defaultValue ?? '');
    settled.current = null;
    setOpen(true);
  }, [request]);

  function close(ok: boolean) {
    settled.current = { ok, value };
    setOpen(false);
  }

  function afterClose() {
    const result = settled.current;
    const current = requestStore.get();
    settled.current = null;
    requestStore.set(null);
    if (!current) return;
    if (result?.ok) current.resolve(result.value);
    else current.reject();
  }

  if (!request) return null;

  return (
    <Modal
      open={open}
      title={request.title}
      okText={request.okText ?? '确定'}
      cancelText={request.cancelText ?? '取消'}
      onOk={() => close(true)}
      onCancel={() => close(false)}
      afterClose={afterClose}
      afterOpenChange={(opened) => {
        if (opened) inputRef.current?.focus();
      }}
      destroyOnHidden
      width={420}
    >
      <p style={{ margin: '0 0 12px' }}>{request.message}</p>
      <Input
        ref={inputRef}
        value={value}
        placeholder={request.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={() => close(true)}
      />
    </Modal>
  );
}
