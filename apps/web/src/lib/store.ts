/**
 * 跨组件共享的最小状态容器。
 *
 * 迁移前这些状态是模块级的 Vue `ref`（useProject / useConversation 里那些），
 * 任何组件 import 到的都是同一份。React 侧用 useSyncExternalStore 保持同一语义：
 * 状态活在模块作用域，组件订阅它 —— 不引 Redux/Zustand，也不用把整棵树包进 Provider。
 */
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
