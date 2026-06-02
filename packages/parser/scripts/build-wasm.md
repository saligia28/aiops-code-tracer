# tree-sitter-java WASM — 获取/构建步骤与版本锁定

本文件记录 `packages/parser/assets/tree-sitter-java.wasm` 的来源、版本对齐关系，以及
出现 ABI 不兼容时的应对方案。这是 **Phase 0 spike（Task 0.1）** 的产物：证明
`web-tree-sitter` 能在 Node 中加载 tree-sitter-java 语法并解析 Java 源码。

## 最终采用的方案与版本（已锁定）

| 组件 | 版本 | 角色 | package.json 位置 |
| --- | --- | --- | --- |
| `web-tree-sitter` | `0.26.9`（精确锁，无 `^`） | 运行时 WASM 绑定 | `dependencies` |
| `tree-sitter-java` | `0.23.5`（精确锁，无 `^`） | **wasm 来源**（仅构建期用） | `devDependencies` |

`.wasm` 文件：`packages/parser/assets/tree-sitter-java.wasm`
- 大小：`414641` bytes
- sha256：`4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4`
- WASM ABI / LANGUAGE_VERSION：`14`（由 `web-tree-sitter` 0.26.9 成功加载并报告）
- 来源：`tree-sitter-java@0.23.5` npm 包自带的 `tree-sitter-java.wasm`
  （即 `node_modules/.../tree-sitter-java/tree-sitter-java.wasm`，不是 `src/` 自建）。

> 关键结论：`web-tree-sitter@0.26.9` 的 emscripten 动态链接加载器与
> tree-sitter-java 0.23.x（ABI 14）随包的 wasm **兼容**。

## 复现 / 更新 wasm 的步骤（采用方案）

wasm 随 `tree-sitter-java` npm 包发布，无需自建工具链。复制即可：

```sh
# 在仓库根目录执行；版本由 package.json 精确锁定，pnpm 装到 .pnpm 硬链接存储下。
# 用 find 定位（与 pnpm 布局解耦，避免依赖 package.json exports 是否暴露子路径）：
SRC="$(find node_modules/.pnpm -path '*tree-sitter-java@0.23.5*/tree-sitter-java/tree-sitter-java.wasm' | head -1)"
cp "$SRC" packages/parser/assets/tree-sitter-java.wasm

# 校验
shasum -a 256 packages/parser/assets/tree-sitter-java.wasm
# 期望: 4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4
```

> 注：`require.resolve('tree-sitter-java/tree-sitter-java.wasm')` 在本仓库不可用——
> `tree-sitter-java` 的 package.json `exports` 未暴露该子路径，且 pnpm 严格布局下
> 包被提升到 `.pnpm` 存储。本次实际复制源路径为：
> `node_modules/.pnpm/tree-sitter-java@0.23.5/node_modules/tree-sitter-java/tree-sitter-java.wasm`。

验证（smoke test）：

```sh
pnpm --filter @aiops/parser exec vitest run __tests__/java/treeSitter.smoke.test.ts
```

smoke test 通过即代表 ABI 兼容（`rootNode.type === 'program'`，`hasError === false`）。

## ABI 风险记录：被否决的备选方案

这是本 spike 的核心，必须留痕。

### 方案 A（被否决）：`tree-sitter-wasms` 预编译包

- 试过：`tree-sitter-wasms@0.1.13` 的 `out/tree-sitter-java.wasm`。
- 结果：`Language.load()` **失败**。原始报错栈定位在
  `getDylinkMetadata` → `failIf`（`web-tree-sitter.js` 内部），错误 message 为空字符串。
- 根因：`tree-sitter-wasms@0.1.13` 由较旧的 tree-sitter CLI 构建，其 wasm
  dylink 元数据格式与 `web-tree-sitter@0.26.9` 的加载器不兼容（典型 ABI/格式错配）。
- 处理：移除 `tree-sitter-wasms` 依赖，改用 tree-sitter-java 包自带 wasm（见上）。

### 方案 B（未采用，留作 fallback）：用对齐版本的 tree-sitter CLI 自建

若将来升级 `web-tree-sitter` 后随包 wasm 不再兼容，可自建：

```sh
# CLI 版本需与 web-tree-sitter 大版本对齐；0.26.x 会自动下载 wasi-sdk（需联网）
pnpm dlx tree-sitter-cli@<对齐版本> build --wasm \
  node_modules/.pnpm/tree-sitter-java@<ver>/node_modules/tree-sitter-java
# 产物 tree-sitter-java.wasm 复制到 packages/parser/assets/ 并重跑 smoke test
```

无论走哪条路，**判定标准只有一个：smoke test 真实通过**。

## 升级须知

- 升级 `web-tree-sitter` 时，必须重跑 smoke test 验证随包 wasm 是否仍兼容；
  不兼容则改用方案 B 自建对齐版本的 wasm。
- `assets/tree-sitter-java.wasm` 必须随包提交（已确认未被 `.gitignore` 忽略），
  运行时按绝对路径加载，与 cwd 无关。
- 版本一律精确锁定（无 `^`），避免 minor 漂移引入 ABI 不兼容。
