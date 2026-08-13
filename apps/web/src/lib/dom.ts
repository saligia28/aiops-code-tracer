/**
 * Vue `nextTick()` 的对等件：等 React 把这一轮更新刷进 DOM 之后再往下走。
 *
 * AnswerView 的流式渲染要在"内容渲染完"之后立刻贴底滚动，用 rAF 卡在
 * 下一帧绘制前读 scrollHeight，拿到的就是更新后的尺寸。
 */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
