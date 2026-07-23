# Quiet Grid 双主题改造 — 布局基线与验收记录

> 本文件是 Quiet Grid 样式改造的验收台账：记录改造起点的干净基线、环境、自动检查结果、
> 布局契约现状，以及后续截图矩阵与已知差异。随 Task 推进更新，Task 10 定稿。

## 1. 环境

| 项 | 值 |
|---|---|
| 分支 | `feat/quiet-grid-redesign`（基于 `master`） |
| 基线提交 SHA | `b15be636df274c4e78c0d94bdade95f912eaa287` |
| Web dev server | `http://127.0.0.1:4200`（Vite） |
| API server | `http://127.0.0.1:4201`（`/api/auth/status` → `authEnabled: true`，需登录） |
| Playwright 预览端口 | `4173`（Task 9 自建，改造起点空闲） |
| 关键依赖 | Vue `^3.5`、Vite `^6.1`、Element Plus `^2.9`、@antv/g6 `^5.0`、vue-router `^4.5` |

## 2. 自动检查基线（改造前）

在基线 SHA `b15be63` 上运行：

```bash
pnpm --filter @aiops/web typecheck   # 退出码 0
pnpm --filter @aiops/web build       # 退出码 0
```

- 两条命令均退出码 0。
- 构建存在 2 条**改造前既有**警告，不属于本次样式范围，仅记录：
  1. `src/router/index.ts` 被 `http.ts` 动态导入同时被 `main.ts` 静态导入，动态导入不会拆分 chunk。
  2. 部分 chunk 压缩后 > 500 kB（`AnswerView` / `index`）。
- 尚无测试脚本：`package.json` 无 `test:unit` / `test:e2e`，无 vitest / playwright，无 `*.test.ts` / `*.spec.ts`。

## 3. 前置位置修复：已完成（闸门判定）

计划文档要求样式改造必须建立在"全局上下文栏 / 选择器位置 / 问答页高度与响应式"的前置修复之上
（见 `docs/superpowers/specs/2026-07-22-global-context-navigation-design.md`）。改造前对 `apps/web`
做了架构审计，确认前置修复**已在 `master` 落地**，闸门满足：

- ✅ **应用壳已就位**：`App.vue` 为 `.app-shell`（`height:100dvh; flex column; overflow:hidden`）
  › `.global-context-bar`（`flex:0 0 48px`，`v-if="!isPublicPage"`，内含 `.global-brand` + `.context-controls` › 项目/模型选择器）
  › `.app-content`（`flex:1; min-height:0; overflow:auto`）。无 `calc(100vh - N)` 视口魔法数。
- ✅ **选择器双布局**：桌面 `position:relative` 内嵌、面板 `top:calc(100%+8px); right:0` 向下展开；
  `@media(max-width:768px)` 切换为右下角 44px 固定浮钮（唯一的 `position:fixed`，设计如此）。
  触发器已具备 `min-width:0` + `overflow:hidden;text-overflow:ellipsis;white-space:nowrap` 长名省略。
- ✅ **问答页滚动所有权干净**：`.answer-page` 为 `height:100%; min-height:0; overflow:hidden`，
  内部三处独立滚动（会话列表 `el-scrollbar`、消息区 `overflow-y:auto`、记忆列表 `el-scrollbar` `max-height`），
  输入区 `flex-shrink:0` 常显；移动端侧栏为遮罩抽屉（`translateX(-100%)` + `.sidebar-backdrop`）。
- ✅ **无双滚动**：`.app-content` 为内容型页面唯一外层滚动源。

结论：**前置位置修复已完成**，样式改造只做"贴皮 + 令牌化 + 双主题"，不重做位置逻辑。

## 4. 改造起点现状（restyle target 摘要）

- 🔴 **无令牌层 / 无 CSS 变量**：全站颜色硬编码，蓝紫主色 `#4f6ef7` 出现约 107 次；
  语义色散落（成功 `#67c23a`、警告 `#e6a23c`、危险 `#f56c6c/#e74c3c/#d03050`、若干中性灰）。
- 🔴 **无主题机制**：无 `data-theme` / `prefers-color-scheme` / `localStorage.theme`。
  全局 body 样式硬编码在 `App.vue` 的非 scoped `<style>`（`background:#f5f7fa; color:#303133`）。
- 🔴 **玻璃拟态集中 3 处**：`src/styles/glass-dialog.css`（唯一 styles 目录文件，426 行）、
  `TopProjectSelector.vue`、`TopModelSelector.vue`；含 `backdrop-filter:blur` 与呼吸动画
  `glass-breathe` / `glass-breathe-danger` / `breathe-api` / `dot-pulse`。
- ⚠️ **Element Plus 中度使用**：`el-dialog`×8、`el-select/el-option`×6、`el-scrollbar`×4（问答页承重）、
  `ElMessage`×25 等；三个对话框共用 `glass-dialog.css`。restyle 需全局覆盖 / `:deep()`。
- ⚠️ **AntV G6 未集成**：`GraphExplorer.vue` 是 stub（`el-empty` 占位 + `// TODO: 集成 AntV G6`），
  当前无实时图实例、不读任何主题色。Task 7"同步 G6 双主题"退化为"令牌化占位/工具栏"，
  真正接图时再把节点/边配色接到令牌。
- 中性 stub：`ProjectIcon.vue` 仅 `<img src="/project-icon.png">`，无色、保留不动。

## 5. 截图矩阵（Task 10 定稿）

改造前基线可从 SHA `b15be63` 复现（`git stash` / checkout 后重启 dev）；
本次以 **Playwright 布局回归（Task 9）** 为主要防重叠证据，人工双主题截图矩阵在 Task 10 采集。
矩阵规划（每格记录 URL / 视口 / 数据状态 / 主题 / 控制台）：

| 路由 \ 视口 | 1440×900 | 1200×900 | 769×900 | 768×900 | 390×844 |
|---|---|---|---|---|---|
| `/`（首页） | 浅/深 | — | — | — | 浅/深 |
| `/login` | 浅/深 | — | — | — | 浅/深（含 390×667） |
| `/answer` | 浅/深 | — | 边界 | 边界 | 浅/深 |
| `/graph` | 浅/深 | — | — | — | 浅/深 |
| `/index-manager` | 浅/深 | — | — | — | 浅/深 |
| `/propose-patch` | 浅/深 | — | 边界 | 边界 | 浅/深 |

> 说明：`—` 表示以 Playwright 自动断言覆盖（不单独存图）；`边界` 关注 769/768 切换与浮钮/输入区。

## 6. 已知差异 / 风险

- 首屏主题脚本（`index.html`）与 `src/lib/theme.ts` 的 `resolveInitialTheme` 需保持同逻辑（脚本无法 import）。
- Element Plus 弹层 Teleport 到 body，`data-theme` 必须在 `html` 上，令牌需为全局（非 scoped 穿透）。
- Task 2 建立令牌后、Task 3 未清理 `App.vue` 硬编码 body 色前，可能存在短暂的样式源顺序不一致（中间态，Task 3 收口）。
- 字体：Smiley Sans 自托管复用（OFL-1.1 许可，随文件带许可证），仅用于展示级标题；正文/等宽走系统回退，不依赖网络字体。
