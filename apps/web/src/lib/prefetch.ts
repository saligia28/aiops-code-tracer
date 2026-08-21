/**
 * 空闲预取：首屏画完、主线程闲下来之后再去下载"很可能马上要用、但不该挡首屏"的 chunk。
 *
 * 用在懒加载的顶栏交互件上（模型下拉、项目弹窗）：它们不在关键路径里，
 * 但一旦用户点开却还没到位，面板会先塌一行再弹回来 —— 那种闪烁比省下的几十 KB 更刺眼。
 */
type Importer = () => Promise<unknown> | void;

export function prefetchWhenIdle(...importers: Importer[]): () => void {
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    for (const load of importers) void load();
  };

  // requestIdleCallback 在 Safari 上要到 17 才有，退化成一个短延时同样够用。
  const supportsIdle = typeof window.requestIdleCallback === 'function';
  const handle = supportsIdle
    ? window.requestIdleCallback(run, { timeout: 2000 })
    : window.setTimeout(run, 1000);

  return () => {
    cancelled = true;
    if (supportsIdle) window.cancelIdleCallback(handle);
    else window.clearTimeout(handle);
  };
}
