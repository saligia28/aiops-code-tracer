# 设计：桌面端全局上下文栏与页面导航分层

- 日期：2026-07-22
- 分支：`feat/completeness-eval`
- 状态：设计已确认，待实现

---

## 1. 背景

项目选择器与模型选择器目前由 `App.vue` 全局渲染，并分别固定在桌面左下角和右下角。问答页新增“项目记忆”后，左下角项目浮层会压住侧栏底部的记忆区域；两枚全局浮层也与页面内容缺少稳定的布局关系。

本次将桌面端的项目、模型选择收进统一的全局上下文栏，并与各页面自己的操作导航分成上下两层。用户确认采用两层方案；移动端继续使用现有右下角圆形浮动按钮。

## 2. 目标与非目标

### 目标

1. 桌面端所有非登录页面采用一致的项目、模型入口位置。
2. 全局上下文与页面级操作形成清楚的上下两层关系。
3. 项目与模型面板不再遮挡问答页的会话和项目记忆侧栏。
4. 保留两个选择器现有的数据加载、切换、状态提示、互斥展开与外部点击收起行为。
5. 保留移动端现有浮动按钮的外观、位置与面板交互。

### 非目标

- 不重做项目列表、模型配置面板或移动端样式。
- 不修改项目切换、图谱构建、删除项目、模型切换等业务逻辑。
- 不统一重构各业务页面自己的标题、返回按钮和工具栏。
- 不引入新的状态管理库。

## 3. 已确认的布局

### 3.1 桌面端（宽度大于 768px）

第一层是全局上下文栏，出现在所有非登录页面：

- 左侧：逻瞳品牌入口，点击返回首页。
- 右侧：项目选择器、模型选择器，顺序固定为“项目 → 模型”。
- 高度固定为 48px，白色背景和底部分隔线沿用问答页现有导航语言。
- 选择器触发器进入正常文档流，不再使用左下角/右下角的 `position: fixed`。
- 两个展开面板从触发器下方向下展开，右侧对齐，并保持当前层级与阴影。

第二层由当前路由页面自己管理：

- 问答页保留返回、会话侧栏开关和“普通模式 / Agent 模式”。
- 问答页第二层的逻瞳品牌入口仅在桌面端隐藏；移动端继续显示现有入口。
- 图谱浏览、索引管理、修改提案等页面继续使用现有页面标题和返回操作。
- 首页保留中心内容中的产品标题；它是页面主视觉，不承担全局导航职责。
- 全局品牌和页面返回按钮都可回首页；桌面端的这一处入口冗余是有意保留，分别承担“全局品牌入口”和“当前页面返回”语义。

### 3.2 移动端（宽度小于等于 768px）

- 隐藏第一层全局栏的品牌、背景、边框和高度，但不隐藏包含两个选择器的祖先节点；`GlobalContextBar` 与 `ContextControls` 两层都必须变成零盒子。
- `TopProjectSelector` 和 `TopModelSelector` 继续采用当前固定在右下角的 44px 圆形按钮。
- 两个按钮现有的垂直间距、安全区计算、图标、展开宽度与展开方向保持不变。
- 页面原有移动端导航和问答侧栏抽屉不变。

## 4. 组件与布局结构

### 4.1 App 壳

`App.vue` 从“两个浮层 + router-view”调整为纵向应用壳：

```text
AppShell
├── GlobalContextBar（非登录页，桌面可见）
│   ├── BrandLink
│   └── ContextControls
│       ├── TopProjectSelector
│       └── TopModelSelector
└── AppContent
    └── router-view（页面级导航与内容）
```

`AppShell` 使用视口高度的纵向 flex 布局；桌面端 `GlobalContextBar` 固定高度且不收缩，`AppContent` 占据剩余空间。滚动契约固定为：

- `AppShell { height: 100dvh; overflow: hidden; }`
- `GlobalContextBar { flex-shrink: 0; overflow: visible; }`
- `AppContent { flex: 1; min-height: 0; overflow: auto; }`
- `AnswerView { height: 100%; min-height: 0; overflow: hidden; }`，由现有会话区承担内部滚动。
- `Home { min-height: 100%; }`。

这样问答页不需要用“100vh + 顶栏高度”叠加，内容型长页面由 `AppContent` 单独滚动，也不会产生 body 与页面的双滚动。

移动端不能对 `GlobalContextBar`、`ContextControls` 或任何包含选择器的祖先使用 `display: none`。`GlobalContextBar` 与 `ContextControls` 都使用 `display: contents` 消除自身的 padding、gap、最小高度和 flex 占位，只单独隐藏品牌入口；唯一的两个选择器实例由各自媒体查询恢复为当前 fixed 浮层。

`AppContent` 直接包含 `router-view` 渲染出的页面根节点，中间不增加 `<transition>` 或额外 `<div>`，避免 `AppContent → AnswerView/Home` 的 `height: 100%` 链路被无确定高度的包装层截断。

移动端 fixed 定位还有一条壳层不变量：`AppShell`、`GlobalContextBar` 与 `ContextControls` 禁止设置会为 fixed 后代创建新包含块的 `transform`、`filter`、`perspective`、`will-change`、`contain` 或 `backdrop-filter`。否则两个浮动按钮会改为相对祖先定位，并被 `AppShell { overflow: hidden }` 裁剪。全局栏保持普通白色背景，不使用玻璃滤镜。

登录页与路由守卫使用同一来源判断：`route.meta.public` 为真时不渲染全局上下文栏，也不渲染两个选择器，不再只写死判断 `route.name === 'Login'`。

### 4.2 选择器的双布局模式

两个选择器只用现有的 CSS 断点切换布局，不新增 `embedded` prop 或 JS 视口判断，避免 768/769px 的 CSS 与 JS 状态漂移：

- 基础样式反转为桌面嵌入态：容器 `position: relative`，保留 `z-index: 1200`（展开态 1210）建立高于后置 `AppContent` 的层叠上下文；触发器正常排布；面板 `position: absolute; top: calc(100% + 8px); right: 0` 并继承该层级。
- 当前基础样式中的 fixed 属性不是继续留在 base，而是整体搬进 `@media (max-width: 768px)`。移动块必须完整重声明 `position: fixed`、项目/模型各自的 `bottom`、`right/left`、`z-index`、`display:flex`、`flex-direction: column-reverse`、`align-items`、`gap`，不能依赖桌面 base 继承这些属性。桌面 base 已把面板改为绝对定位，因此移动块还必须显式恢复 `.project-panel` / `.llm-panel { position: static; top: auto; right: auto; margin-bottom: 8px; }`，让面板重新成为 `column-reverse` 的 flex 子项并保持当前向上展开方向。
- 移动端组件祖先必须保持可渲染，不能被 `display: none` 隐藏。
- 组件模板、请求逻辑和事件协议不拆分，避免为桌面/移动端维护两份行为。

项目与模型仍通过 `floating-panel-open` 事件互斥：打开任意一个时，另一个自动收起。

### 4.3 页面高度适配

- `AnswerView` 的根节点从独占视口改为填满 `AppContent` 的可用高度，并用 `overflow: hidden` 保证会话区、记忆区和输入区仍在剩余空间内正确伸缩。
- `Home` 的最小高度改为填满 `AppContent`，保持内容垂直居中，同时避免全局栏之外再计算一个完整视口。
- `GraphExplorer` 当前画布使用 `height: calc(100vh - 200px)`，必须改为基于 `AppContent` 的 flex 高度：页面根节点填满可用高度并纵向布局，画布用 `flex: 1; min-height: 0` 占据页面标题和工具栏之外的空间，不再引用 `100vh`。
- 其余内容型页面由 `AppContent { overflow: auto }` 提供唯一的外层滚动，不强制改成固定高度。

仓库当前没有 `window.scroll*`、`document.*scroll`、`scrollIntoView` 或路由 `scrollBehavior`；现有滚动脚本只操作问答页内部 ref。因此把 body 滚动所有权迁到 `AppContent` 不会打断现有脚本。

## 5. 交互与状态

1. 点击项目或模型触发器，面板在第一层导航下方展开。
2. 展开一个面板时通过现有事件关闭另一个面板。
3. 点击组件外部时收起；Teleport 到 body 的内部弹层继续依赖当前白名单类名：模型下拉保留 `.llm-floating-owned-popper`，项目创建/删除对话框保留 `.glass-dialog`。重排不得删除或重命名这两个外部点击守卫。
4. 路由变化不重建业务状态模型；选择器仍由 `App.vue` 持有并跨页面存在。
5. 项目切换后，现有会话列表与项目记忆刷新逻辑不变。
6. 移动端所有交互路径保持当前行为。

## 6. 响应式与空间约束

- 桌面上下文栏在 769px 及以上启用。
- 触发器保留文本省略与最大宽度，项目名或模型名过长时不挤出导航。
- 项目和模型面板使用既有 300px / 340px 宽度；接近视口右侧时从右向左展开，保证不越界。
- 窄桌面宽度下优先压缩触发器文本，不能压缩品牌和状态点。
- 768px 及以下直接切回现有移动浮层，不设计中间态或第三套样式。

## 7. 文件范围

预期改动集中在：

- `apps/web/src/App.vue`：全局上下文栏和应用壳。
- `apps/web/src/components/TopProjectSelector.vue`：桌面嵌入态与向下展开。
- `apps/web/src/components/TopModelSelector.vue`：桌面嵌入态与向下展开。
- `apps/web/src/views/AnswerView.vue` / `AnswerView.styles.css`：仅在桌面隐藏重复品牌，并适配剩余高度。
- `apps/web/src/views/Home.vue`：适配应用内容区高度。
- `apps/web/src/views/GraphExplorer.vue`：移除画布对 `100vh` 的重复计算，改为填充 `AppContent` 剩余高度。

如果实现时可用纯 CSS 完成某项适配，不新增只为样式转发的组件或 composable。

## 8. 错误处理与可访问性

- 现有加载、接口超时、切换失败和重试提示保持不变。
- 项目/模型触发器继续使用原生 `button`，支持键盘聚焦和 Enter/Space 激活。
- 品牌入口使用可交互元素并提供明确的首页语义。
- 展开状态应通过 `aria-expanded` 暴露；面板与触发器可补充 `aria-controls`，但不扩大到全面无障碍重构。
- 全局栏出现时不得盖住 Element Plus 消息、确认框或创建/删除项目对话框。

## 9. 验证与验收

### 自动检查

- `pnpm --filter @aiops/web typecheck`
- `pnpm --filter @aiops/web build`
- 当前 `apps/web` 没有测试脚本或浏览器测试基础设施，本次不为单一布局改动引入新框架。响应式、越界和滚动行为以真实浏览器验收记录为准。

### 浏览器验收

桌面端使用 1440×900 和 769×900 两组视口，至少检查首页、问答页、图谱浏览、索引管理和修改提案页：

1. 第一层全局栏位置一致，项目和模型入口没有遮挡页面内容。
2. 第二层页面导航保留原功能，问答页桌面端无重复品牌。
3. 两个面板均向下展开、互斥、点击外部收起，且不越出视口。
4. 问答页侧栏展开/收起、项目记忆滚动与输入区高度正常。
5. 页面没有因新增全局栏产生多余的整页滚动。
6. 路由切换时两个选择器实例不重建，当前项目与模型状态保持。
7. Element Plus 模型下拉，以及项目创建/删除对话框内操作，不会误触选择器的外部点击收起逻辑。

移动端使用 768×900 和 390×844 两组视口检查：

1. 第一层全局栏的品牌和视觉盒隐藏，但两个选择器仍存在。
2. 两个圆形浮动按钮的位置、间距和面板与改动前一致。
3. 问答页现有品牌入口、侧栏抽屉、遮罩和输入区不受影响。
4. 登录页在桌面和移动端均不渲染项目或模型选择器。

## 10. 风险与控制

| 风险 | 控制 |
|---|---|
| 应用壳改变高度后，问答页出现双滚动或输入区被挤出 | `AppShell` 固定视口并禁用外层滚动，`AppContent` 承担内容页滚动，`AnswerView` 禁止外层滚动并保留内部会话滚动 |
| 桌面面板从“向上”改为“向下”后越界或被页面内容盖住 | 面板相对触发器绝对定位、右对齐；嵌入容器保留 1200/1210 层级，并检查最小支持桌面宽度 |
| 全局栏与页面导航视觉重复 | 第一层只表达品牌与运行上下文；第二层只表达当前页面操作 |
| 移动端被桌面重构误伤 | 两层祖先均 `display:contents`，不使用 fixed containing-block 属性；移动媒体查询完整重声明现有 fixed 属性，并做 768px/769px 边界回归 |
| 现有选择器逻辑在重排后被复制或分叉 | 保留单一组件实例和现有事件/请求逻辑，只增加布局模式 |
| 图谱画布仍按整个视口计算而溢出 AppContent | `GraphExplorer` 根节点改为可用高度内的纵向 flex，画布用 `flex:1; min-height:0`，不再使用 `100vh` |

## 11. 完成标准

- 桌面所有非登录页面顶部都显示统一的项目、模型上下文栏。
- 问答页项目记忆区域不再被项目选择器遮挡。
- 桌面项目与模型面板从顶部栏向下展开且互斥。
- 移动端视觉与交互保持当前形态。
- 前端类型检查与构建通过，桌面/移动端浏览器验收矩阵有记录且无布局回归。
