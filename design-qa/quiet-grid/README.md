# Quiet Grid 双主题改造 — 布局基线与验收记录

> 本文件是 Quiet Grid 样式改造的验收台账：改造起点的干净基线、环境、自动检查、
> 布局契约、截图矩阵与已知差异。**状态：Task 1–10 全部完成，本文件为验收定稿。**

## 1. 环境

| 项 | 值 |
|---|---|
| 分支 | `feat/quiet-grid-redesign`（基于 `master`） |
| 基线提交 SHA | `b15be636df274c4e78c0d94bdade95f912eaa287` |
| Web dev server | `http://127.0.0.1:4200`（Vite） |
| API server | `http://127.0.0.1:4201`（`/api/auth/status` → `authEnabled: true`，需登录） |
| Playwright 预览端口 | `4173`（`pnpm exec vite --port 4173 --strictPort` 自建，与开发栈 4200/4201 隔离） |
| 关键依赖 | Vue `^3.5`、Vite `^6.1`、Element Plus `^2.9`、@antv/g6 `^5.0`、vue-router `^4.5` |
| 新增测试依赖 | vitest `3.0.9`、@playwright/test `1.54.1`（+ chromium） |

## 2. 自动检查结果

| 命令 | 基线（`b15be63`） | 定稿（本分支 HEAD） |
|---|---|---|
| `pnpm --filter @aiops/web typecheck` | 退出 0 | **退出 0** |
| `pnpm --filter @aiops/web build` | 退出 0 | **退出 0**（`✓ built`） |
| `pnpm --filter @aiops/web test:unit` | 无脚本 | **3 passed**（`tests/theme.test.ts`） |
| `pnpm --filter @aiops/web test:e2e` | 无脚本 | **43 passed**（5 视口 × 6 路由布局矩阵 + 双主题持久化，`quiet-grid-layout.spec.ts`） |
| `pnpm --filter @aiops/web test:screenshots` | 无脚本 | **18 captured**（明暗视觉矩阵，`screenshots.spec.ts`，仅生成不断言） |

- 构建仍有 2 条**改造前既有**告警（非本次范围）：`router/index.ts` 静态+动态混合导入；部分 chunk > 500 kB。
- E2E 断言基于真实 `getBoundingClientRect` 矩形相交与 `documentElement.scrollWidth`，非无意义阈值；
  API 仅 mock 布局所需稳定数据（含极长项目名/模型名、就绪索引），不伪造业务成功；WebSocket 用 `routeWebSocket` 空挂起。

## 3. 前置位置修复：已完成（闸门判定）

样式改造建立在"全局上下文栏 / 选择器位置 / 问答页高度与响应式"的前置修复之上
（见 `docs/superpowers/specs/2026-07-22-global-context-navigation-design.md`）。改造前审计确认前置修复**已在 `master` 落地**：

- ✅ **应用壳已就位**：`.app-shell`（`100dvh; flex column; overflow:hidden`）› `.global-context-bar`（`flex:0 0 48px`，`v-if="!isPublicPage"`）› `.app-content`（`flex:1; min-height:0; overflow:auto`）。无 `calc(100vh - N)`。
- ✅ **选择器双布局**：桌面内嵌向下展开；`@media(max-width:768px)` 右下角 44px 固定浮钮（唯一 `position:fixed`）；触发器 `min-width:0` + 省略。
- ✅ **问答页滚动所有权干净**：`.answer-page` `height:100%; overflow:hidden` + 三处内部滚动；输入区常显；移动端遮罩抽屉。
- ✅ **无双滚动**：`.app-content` 为内容页唯一外层滚动源。

结论：样式改造只做"贴皮 + 令牌化 + 双主题"，**不重做位置逻辑**。E2E 43 项在零 `src` 改动下全过，反证布局契约未被 reskin 破坏。

## 4. 改造起点现状（restyle target 摘要，历史留存）

- 🔴 无令牌层：全站硬编码，蓝紫主色 `#4f6ef7` 约 107 次；语义色散落。
- 🔴 无主题机制：无 `data-theme` / `prefers-color-scheme` / `localStorage.theme`；body 硬编码在 `App.vue` 非 scoped `<style>`。
- 🔴 玻璃拟态集中 3 处：`glass-dialog.css`、`TopProjectSelector.vue`、`TopModelSelector.vue`（`backdrop-filter` + `glass-breathe`/`breathe-api`/`dot-pulse`）。
- ⚠️ Element Plus 中度使用（`el-dialog`×8、`el-select`×6、`ElMessage`×25…），经全局 `--el-*` → `--qg-*` 变量映射统一主题。
- ⚠️ AntV G6 **未集成**（`GraphExplorer` 为 `el-empty` 占位 stub）；本次仅令牌化占位与工具栏，接图时再把节点/边配色接令牌。

## 5. 截图矩阵（定稿，实际采集）

`pnpm --filter @aiops/web test:screenshots` 生成 18 张 `fullPage` 截图到
`design-qa/quiet-grid/screenshots/`（该目录已 gitignore，可随时重生成；每张固定注入 `localStorage.theme` 保证明暗确定）：

| 视口 | 路由 × 主题 | 文件 |
|---|---|---|
| 桌面 1440×900 | `/ /login /answer /graph /index-manager /propose-patch` × {light,dark}（12 张） | `<slug>-{light,dark}-desktop.png` |
| 移动 390×844 | `/ /answer /login` × {light,dark}（6 张） | `<slug>-{light,dark}-mobile.png` |

**人工核验（已逐张看图）**：首页明/暗、问答台暗、修改提案暗、登录暗、问答移动明 —— Quiet Grid 观感连贯：
暖米白/近黑底、细边框、低圆角、展示字体标题（Smiley Sans）、mono 元信息、无玻璃/无蓝紫残留；
双主题一致；极长项目名/模型名在触发器内省略不外溢；移动端两枚方形 FAB 位于输入条之上不遮挡；
diff 添加/删除色由 `--qg-success`/`--qg-danger` 令牌驱动，暗色可读；disabled 按钮为静音灰（非纯透明度歧义）。

> 布局边界（769/768/390、面板越界、FAB vs 输入区、桌面侧栏并列/移动抽屉遮罩、无横向滚动）由 Task 9 的 43 项 Playwright 断言覆盖，不再单独存图。

## 6. 无障碍 / 键盘 / 动效

- `:focus-visible` 全局可见焦点环（`quiet-grid.css:99` + 原生控件 126–129）；令牌 `--qg-focus` 双主题皆可辨。
- `ThemeToggle` 提供 `aria-label`（"切换到夜间模式/白天模式"），移动端 44×44 触达区；选择器触发器保留原生 `button` + `aria-expanded`/`aria-controls`。
- `@media (prefers-reduced-motion: reduce)`（`quiet-grid.css:134`）统一压制过渡/动画时长；保留的 `spin`/`pulse`/`bounce` 为功能性加载指示，受该规则约束。
- 主题三处同步经 E2E 断言：`data-theme` / `document.documentElement.style.colorScheme` / `meta[name=theme-color]`；无存储值时跟随 `prefers-color-scheme`，手动切换写 `localStorage` 并刷新保持。

## 7. 已知差异 / 决策

- **移动端主题入口**：桌面全局栏在 `≤768px` 变 `display:contents`、选择器转 fixed 浮钮；`ThemeToggle` 无 fixed 定位，故在壳内于 `≤768px` 隐藏（避免游离元素），**登录页保留右上角主题入口**。这是刻意取舍，非缺陷；如需移动端各页可切换主题，可后续新增第三枚浮钮（独立需求）。
- **G6 双主题**：图谱未接入 G6，`GraphExplorer` 占位已令牌化；真正接图时需把节点/边/背景/选中态配色接 `--qg-*`（计划 Task 7 Step 2 当前为 N/A）。
- **class 命名保留**：`glass-dialog.css` 保留 `.glass-*` 类名只重皮肤——`TopProjectSelector` 的 `closest('.glass-dialog')` 点击外关闭白名单依赖该名；`TopModelSelector` 的 `.llm-floating-owned-popper` 同理保留。
- **字体**：Smiley Sans 自托管复用（OFL-1.1，随文件带许可证），仅用于展示级标题；正文/等宽为 `IBM Plex Sans SC`/`IBM Plex Mono` 字体栈 + 系统回退，不依赖网络字体。
- `color-mix(in srgb, …)` 用于少量令牌半透明（focus 环、diff/危险淡底、delete hover）；现代 Chromium/Safari/Firefox 均支持，不支持时降级为实色边框。

## 8. 完成定义核对

- ✅ 用户明确授权实施（`/goal` 指令）。
- ✅ 白天/夜间首屏无闪（`index.html` 首绘前内联脚本，镜像 `resolveInitialTheme`）；手动选择持久化；默认跟随系统。
- ✅ 首页/登录/问答/图谱/索引/修改提案/项目·模型面板/对话框统一 Quiet Grid 令牌。
- ✅ 1440/1200/769/768/390 五档视口无重叠、挤压、意外横向滚动或双滚动（43 项 E2E 断言 + 逐张看图）。
- ✅ 极长项目名/模型名省略不外溢；diff 双主题可读；对话框/浮层去玻璃。
- ✅ Element Plus 浮层经 `--el-*` → `--qg-*` 全局映射 + `.el-popper`/`.el-message` 令牌兜底。
- ✅ Unit(3) / E2E(43) / typecheck / build 全通过并记录实际结果。
- ✅ 业务逻辑/路由/接口/问答/图谱/索引/提案行为未变：reskin 提交经"模板+脚本逐字节比对"与"布局属性不变量"核验（仅 ProposePatch 删 1 处死 `useRouter`）。
- ✅ 未覆盖或误提交样式工作开始前的用户改动（每次提交按路径精确暂存，未用 `git add -A`）。

## 9. 终审与修复（fresh-eyes 复核）

全部任务完成后做了一轮整体终审，抓到一类机械核验（源码 grep 扫不到、值来自 `node_modules` 计算变量）与我早前截图漏看的 **Element Plus 暗色缺陷**，已修（提交 `90c880f`）：

- **C1（严重，已修）**：暗色下 `el-button type="primary"` 文字近乎不可见——EP 用 `--el-color-white` 作主按钮文字，而基色映射未覆盖它，近白底 + 白字 ≈ 1.05:1（`/index-manager` 的"全量构建"）。修法：在 `quiet-grid.css` 补 `.el-button--primary` 的 `--el-button-text-color: var(--qg-bg)` 等组件级变量。
- **I1（已修）**：EP 派生色阶（`--el-color-primary-light-3/9`、`-dark-2`）未映射，hover/active 泄漏默认蓝。修法：基 `:root` 把 primary 色阶中和为中性令牌。
- **I2（已修）**：`el-tag` 类型底色走 `*-light-9` 近白，暗色下刺眼低对比。修法：用 2 类特异性 `.el-tag.el-tag--X` 把 `--el-tag-bg-color` 钉成 `--qg-surface` + 令牌文字色（EP 同选择器同特异性，需提权才稳赢）。
- **M2（已修）**：`.el-message__content` 曾被统一压成 `--qg-fg`，抹掉了 success/error 类型强调。修法：改为只钉 `--el-message-bg-color` 暗色面，保留 EP 按类型文字色。
- **M1（已修）**：API 为默认稳态却常驻 `--qg-warning` 琥珀"告警"点，语义误导。改为中性 `--qg-fg`（模式仍由"API/内网"文字徽标区分）。

修复后复验：`typecheck`/`build` 退出 0，`test:e2e` 43 passed，`test:screenshots` 18 重出；逐张看图确认暗色主按钮文字可读、状态 tag 转暗底令牌、API 点中性——明色未回归。

> 非阻塞观察（留档）：暗色 `--qg-elevated`(#151619) 比 `--qg-surface`(#191a1d) 更暗，与亮色"抬升更亮"相反，面板/页面在暗色下主要靠 1px 边框区分——沿用计划 §2 令牌值，视为 Quiet Grid 有意取舍。

## 10. 合并后（master）用户反馈修复

改造合并回 `master` 后，据用户在真实环境的反馈补修（均为暗色可读性/品牌一致性，行为不变）：

- **品牌 LZ 图标夜间不可见 + 全局栏图标不统一**（`411bc16`）：`project-icon.png` 是黑色 logo，暗色下消失。加 `[data-theme='dark'] .project-icon { filter: invert(1) }`——黑 LZ 夜间自动反相为白，Home/登录/问答/AI 头像一处全修；全局栏原来的通用"圆圈对勾" SVG 换成 `ProjectIcon`（LZ 品牌标志，与 favicon 同款）。用透明底 `project-icon.png` 内嵌（实底 `favicon.png` 会露白框）。
- **夜间代码块 `plaintext` 文字太暗不可读**（`d41da67`）：AnswerView 引入 highlight.js 的 `github.css`（亮色主题深字），暗色代码块底是令牌暗面、文字仍是深色→贴死。加 `[data-theme='dark']` 的 hljs 覆盖（镜像 `github-dark` 调色板，base=`var(--qg-fg)`；`[data-theme=dark] .hljs` 特异性 0,2,0 稳压 github 的 0,1,0）。新增回归断言"暗色 hljs 文字亮度>140"，`test:e2e` 现 **44 passed**。
