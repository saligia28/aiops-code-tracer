/**
 * 给非组件代码（axios 拦截器）用的路由跳转出口。
 *
 * 迁移前 http.ts 直接 import vue-router 单例来 push；React Router 的
 * navigate 只能从组件里拿，所以由 App 挂载时登记一次，模块侧调用这里的转发。
 * 登记之前（极早期的 401）退化为整页跳转，保证一定跳得走。
 */
type Navigate = (to: string) => void;

let navigate: Navigate | null = null;

export function setNavigate(fn: Navigate): void {
  navigate = fn;
}

export function navigateTo(to: string): void {
  if (navigate) navigate(to);
  else window.location.assign(to);
}
