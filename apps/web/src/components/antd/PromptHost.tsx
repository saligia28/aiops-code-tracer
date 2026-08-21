/**
 * 输入型确认框的渲染侧。被 AntdProvider 懒加载：只有真的发起 prompt() 时才下载。
 *
 * 挂在 AntdProvider 内部，所以能继承主题；关闭动画播完才兑现 Promise，
 * 避免弹窗还在淡出就被卸载。
 */
import { Input, Modal } from 'antd';
import type { InputRef } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/store';
import { requestStore } from './prompt';

export default function PromptHost() {
  const request = useStore(requestStore);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<InputRef>(null);
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
