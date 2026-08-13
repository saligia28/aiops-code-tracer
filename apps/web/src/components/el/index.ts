/**
 * Element Plus 组件的 React 对等件集合。
 *
 * 迁移到 React 后不再依赖 element-plus 运行时（Vue 组件库），但页面视觉与交互必须
 * 与迁移前一致 —— 这里的组件渲染与 EP 完全同构的 DOM/类名，消费
 * src/styles/element-plus.css（原版 theme-chalk 子集）。
 */
export { ElDialog } from './ElDialog';
export { ElScrollbar } from './ElScrollbar';
export { ElSelect, type ElSelectOption } from './ElSelect';
export { ElPopconfirm } from './ElPopconfirm';
export { ElMessage } from './ElMessage';
export { ElMessageBox } from './ElMessageBox';
export { ElButton, ElTag, ElCard, ElDescriptions, ElProgress, ElInput, ElEmpty } from './basic';
export { Popper } from './Popper';
