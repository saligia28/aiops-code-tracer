# Global Context Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the desktop project and model selectors into a shared 48px global context bar while preserving the current mobile floating controls and all selector business behavior.

**Architecture:** `App.vue` becomes a fixed-height flex shell with a desktop context bar and one scroll-owning content region. The existing selector components remain single long-lived instances; their base CSS becomes desktop embedded layout and their complete current fixed layout moves into the existing mobile media query. Route pages only receive the height fixes required by the new shell.

**Tech Stack:** Vue 3 `<script setup>`, Vue Router 4, scoped CSS, Element Plus, pnpm, vue-tsc, Vite.

---

## Working-tree constraints

- Do not create or use a git worktree; the user explicitly chose the current workspace workflow.
- Preserve all pre-existing user changes. At plan creation time these include changes under `apps/web/index.html`, `AnswerView.vue`, `Home.vue`, `Login.vue`, `apps/web/public/`, `ProjectIcon.vue`, and unrelated files.
- Before each edit, run `git status --short` and inspect the current file, because concurrent user changes may continue.
- Use `apply_patch` for edits. Never reformat an entire existing file.
- Stage only task-owned files or exact hunks. In particular, use `git add -p apps/web/src/views/Home.vue` and accept only the `min-height` hunk; never stage the user's icon/template changes with this task.
- Do not edit or stage the user's `ProjectIcon.vue` or favicon work. The global brand may use the existing inline logo to keep this feature commit independent of untracked assets.

## File map

- Modify `apps/web/src/App.vue`: application shell, 48px desktop context bar, public-route visibility, mobile zero-box ancestors.
- Modify `apps/web/src/components/TopProjectSelector.vue`: ARIA state and desktop/mobile CSS inversion.
- Modify `apps/web/src/components/TopModelSelector.vue`: ARIA state and desktop/mobile CSS inversion.
- Modify `apps/web/src/views/AnswerView.styles.css`: fill `AppContent`, own internal overflow, hide duplicate brand only on desktop.
- Modify `apps/web/src/views/Home.vue`: replace `min-height: 100vh` with `100%` without staging unrelated user hunks.
- Modify `apps/web/src/views/GraphExplorer.vue`: remove the remaining `100vh` calculation and fill `AppContent` through flex.
- Reference `docs/superpowers/specs/2026-07-22-global-context-navigation-design.md`: source of truth for behavior and QA.

### Task 1: Establish a clean baseline without touching user work

**Files:**
- Read: all files in the file map
- Do not modify files

- [ ] **Step 1: Record the current working tree**

Run:

```bash
git rev-parse HEAD
git status --short
git diff -- apps/web/src/App.vue \
  apps/web/src/components/TopProjectSelector.vue \
  apps/web/src/components/TopModelSelector.vue \
  apps/web/src/views/AnswerView.styles.css \
  apps/web/src/views/Home.vue \
  apps/web/src/views/GraphExplorer.vue
```

Expected: record the first command's output as `NAV_BASE_SHA` for the final commit-range audit. Known user changes may appear in `Home.vue`; no task implementation is present yet. If any selector, App shell, Answer stylesheet, or Graph Explorer change appeared concurrently, inspect and merge rather than overwrite.

- [ ] **Step 2: Run the Web baseline typecheck**

Run:

```bash
pnpm --filter @aiops/web typecheck
```

Expected: exit 0. If it fails because of pre-existing user work, record the exact failure and stop before attributing it to this task.

### Task 2: Build the global App shell and desktop context bar

**Files:**
- Modify: `apps/web/src/App.vue:1-29`

- [ ] **Step 1: Replace the flat App template with the shell**

Use one direct `AppContent → router-view → route root` height chain. The structure should be equivalent to:

```vue
<template>
  <div class="app-shell">
    <header v-if="!isPublicPage" class="global-context-bar">
      <button class="global-brand" type="button" @click="router.push('/')">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12l2.5 2.5L16 9" />
        </svg>
        <span>逻瞳</span>
      </button>
      <div class="context-controls">
        <TopProjectSelector />
        <TopModelSelector />
      </div>
    </header>
    <main class="app-content">
      <router-view />
    </main>
  </div>
</template>
```

Import `useRouter`, create `router`, and replace `isLoginPage` with:

```ts
const isPublicPage = computed(() => Boolean(route.meta.public));
```

Do not add a `<transition>` or wrapper inside `.app-content`.

- [ ] **Step 2: Add the desktop shell contract**

Add global styles with these invariants:

```css
html,
body,
#app {
  height: 100%;
}

body {
  overflow: hidden;
}

.app-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.global-context-bar {
  position: relative;
  z-index: 1100;
  flex: 0 0 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 20px;
  overflow: visible;
  background: #fff;
  border-bottom: 1px solid #eef0f4;
}

.context-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
```

Style `.global-brand` as a borderless white button using the existing `#4f6ef7` brand color. Do not add `transform`, `filter`, `perspective`, `will-change`, `contain`, or `backdrop-filter` to `.app-shell`, `.global-context-bar`, or `.context-controls`.

- [ ] **Step 3: Make both selector ancestors zero-box on mobile**

Add:

```css
@media (max-width: 768px) {
  .global-context-bar,
  .context-controls {
    display: contents;
  }

  .global-brand {
    display: none;
  }
}
```

Do not use `display: none` on either selector ancestor.

- [ ] **Step 4: Verify the shell statically**

Run:

```bash
pnpm --filter @aiops/web typecheck
pnpm --filter @aiops/web build
```

Expected: both exit 0. The build should produce the normal Vite `dist` output with no new warnings attributable to `App.vue`.

- [ ] **Step 5: Commit only the App shell**

```bash
git add apps/web/src/App.vue
git diff --cached --name-only
git diff --cached -- apps/web/src/App.vue
git diff --cached --check
git diff --cached --stat
git commit -m "feat(web): add global context navigation shell"
```

Expected: `--name-only` prints only `apps/web/src/App.vue`; the full cached diff contains only the reviewed shell change. If any other staged path appears, stop and unstage that path before committing.

### Task 3: Invert the project selector CSS safely

**Files:**
- Modify: `apps/web/src/components/TopProjectSelector.vue:1-79,236-570`

- [ ] **Step 1: Expose the trigger's expanded state**

Add stable attributes without changing click behavior:

```vue
<button
  ...
  aria-controls="project-selector-panel"
  :aria-expanded="expanded"
>
```

Add `id="project-selector-panel"` to `.project-panel`.

- [ ] **Step 2: Replace the base floating layout with desktop embedded layout**

The base root and panel should be equivalent to:

```css
.project-floating {
  position: relative;
  z-index: 1200;
  display: flex;
  align-items: flex-end;
}

.project-floating.is-expanded {
  z-index: 1210;
}

.project-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 300px;
  /* keep all existing visual declarations */
}
```

Remove desktop `bottom`, `left`, and `column-reverse` from the base root.

- [ ] **Step 3: Fully reconstruct the current mobile root and panel**

Inside `@media (max-width: 768px)`, declare every layout property explicitly:

```css
.project-floating {
  position: fixed;
  bottom: calc(140px + env(safe-area-inset-bottom, 0px));
  right: 16px;
  left: auto;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
}

.project-floating.is-expanded {
  z-index: 1210;
}

.project-panel {
  position: static;
  top: auto;
  right: auto;
  width: min(300px, calc(100vw - 32px));
  max-width: none;
  margin-bottom: 8px;
}
```

Keep the current 44px round trigger, hidden text, visible mobile icon, and hidden status dot unchanged.

- [ ] **Step 4: Run the Web typecheck**

Run:

```bash
pnpm --filter @aiops/web typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit the project selector**

```bash
git add apps/web/src/components/TopProjectSelector.vue
git diff --cached --name-only
git diff --cached -- apps/web/src/components/TopProjectSelector.vue
git diff --cached --check
git commit -m "feat(web): dock project selector in desktop header"
```

Expected: the staged name list contains only `TopProjectSelector.vue`, and the full cached diff matches Steps 1–3.

### Task 4: Invert the model selector CSS safely

**Files:**
- Modify: `apps/web/src/components/TopModelSelector.vue:1-66,260-542`

- [ ] **Step 1: Expose the trigger's expanded state**

Add `aria-controls="model-selector-panel"` and `:aria-expanded="expanded"` to `.llm-trigger`, and add `id="model-selector-panel"` to `.llm-panel`.

- [ ] **Step 2: Replace the base floating layout with desktop embedded layout**

Use the same structure as the project selector:

```css
.llm-floating {
  position: relative;
  z-index: 1200;
  display: flex;
  align-items: flex-end;
}

.llm-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 340px;
  /* keep all existing visual declarations */
}
```

Keep `.llm-floating.is-expanded { z-index: 1210; }`.

- [ ] **Step 3: Fully reconstruct the current mobile root and panel**

Inside `@media (max-width: 768px)` declare:

```css
.llm-floating {
  position: fixed;
  bottom: calc(88px + env(safe-area-inset-bottom, 0px));
  right: 16px;
  left: auto;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
}

.llm-panel {
  position: static;
  top: auto;
  right: auto;
  width: min(340px, calc(100vw - 32px));
  max-width: none;
  margin-bottom: 8px;
}
```

Keep the current mobile trigger/icon states and the `.llm-floating-owned-popper` class unchanged. Do not alter the breathing/error/loading state logic.

- [ ] **Step 4: Run the Web typecheck**

Run:

```bash
pnpm --filter @aiops/web typecheck
```

Expected: exit 0.

- [ ] **Step 5: Commit the model selector**

```bash
git add apps/web/src/components/TopModelSelector.vue
git diff --cached --name-only
git diff --cached -- apps/web/src/components/TopModelSelector.vue
git diff --cached --check
git commit -m "feat(web): dock model selector in desktop header"
```

Expected: the staged name list contains only `TopModelSelector.vue`, and the full cached diff matches Steps 1–3.

### Task 5: Adapt route heights without overwriting current UI work

**Files:**
- Modify: `apps/web/src/views/AnswerView.styles.css:1-7,39-47,956-980`
- Modify: `apps/web/src/views/Home.vue:122-130`
- Modify: `apps/web/src/views/GraphExplorer.vue:34-53`

- [ ] **Step 1: Make AnswerView fill AppContent and keep its internal scroll**

Change the root to:

```css
.answer-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #f9fafb;
  overflow: hidden;
}
```

Hide the duplicate brand only on desktop:

```css
@media (min-width: 769px) {
  .top-bar .brand {
    display: none;
  }
}
```

Do not modify `AnswerView.vue`; its current user-owned `ProjectIcon` work and mobile brand must remain intact.

- [ ] **Step 2: Make Home fill AppContent**

Change only:

```css
.home {
  min-height: 100%;
```

Do not reformat or touch the user's current Home logo changes.

- [ ] **Step 3: Make GraphExplorer use the remaining flex height**

Use:

```css
.graph-explorer {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 20px;
}

.graph-canvas {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* keep existing border/layout visuals; remove calc(100vh - 200px) */
}
```

- [ ] **Step 4: Run static verification**

```bash
pnpm --filter @aiops/web typecheck
pnpm --filter @aiops/web build
```

Expected: both exit 0.

- [ ] **Step 5: Stage only owned changes**

```bash
git add apps/web/src/views/AnswerView.styles.css apps/web/src/views/GraphExplorer.vue
git add -p apps/web/src/views/Home.vue
git diff --cached --name-only
git diff --cached
git diff --cached --check
git diff --cached -- apps/web/src/views/Home.vue
```

Expected: the staged name list contains exactly `AnswerView.styles.css`, `GraphExplorer.vue`, and `Home.vue`. Review the complete cached diff. For the interactive Home staging, accept only the `min-height: 100vh` → `100%` hunk and reject all pre-existing logo/template/import/style hunks. If any unrelated hunk or file appears, stop and unstage it before committing.

- [ ] **Step 6: Commit the route height fixes**

```bash
git commit -m "fix(web): fit route layouts below global header"
```

Expected: the commit contains `AnswerView.styles.css`, `GraphExplorer.vue`, and only the one Home height hunk.

### Task 6: Run real-browser responsive QA

**Files:**
- Inspect only; do not modify app code unless a verified defect is found

- [ ] **Step 1: Start the development stack**

Run in a persistent terminal:

```bash
pnpm dev
```

Expected: API health succeeds on port 4201 (or `.env` override), then Vite serves Web on port 4200 (or `WEB_PORT`).

- [ ] **Step 2: Verify desktop at 1440×900 and 769×900**

In a real authenticated browser, inspect `/`, `/answer`, `/graph`, `/index-manager`, and `/propose-patch`.

For each viewport verify:

- global bar height is exactly 48px and appears at the same location;
- selectors are in the bar in project → model order;
- both panels open downward, remain above page content, stay inside the viewport, and mutually close;
- route navigation remains the second layer;
- Answer desktop brand is hidden, sidebar/memory/input remain usable, and no double scroll appears;
- Graph canvas fits without a 48px overflow;
- switching routes preserves the selected project/model state.
- clicking the global brand returns to `/` without resetting the current project/model state;
- at 769px, temporarily replace the visible project/model labels in DevTools with long strings and verify ellipsis works while the brand, status dots, and badges do not shrink or overflow the bar.

- [ ] **Step 3: Verify external-click allowlists**

Open the model panel and interact with its Element Plus dropdown. Open project create/delete UI and interact inside the `.glass-dialog` dialog.

Expected: `.llm-floating-owned-popper` and `.glass-dialog` interactions do not cause premature outside-click closing.

While an existing Element Plus message, confirm box, or project dialog is visible, verify it remains above the 1100/1200 navigation layers and is not visually covered by a selector panel.

- [ ] **Step 4: Verify mobile at 768×900 and 390×844**

Check `/answer` and `/`:

- no global bar visual box or empty 48px gap exists;
- both 44px floating buttons retain their current right/bottom positions;
- each panel opens upward with current width and spacing;
- opening one mobile selector closes the other, and tapping outside closes the open panel;
- Answer mobile brand remains visible;
- sidebar drawer, backdrop, memory list, and input remain usable.

- [ ] **Step 5: Verify the public route**

Open `/login` at desktop and mobile widths.

Expected: no global bar, project selector, or model selector is rendered. Login retains full viewport height.

- [ ] **Step 6: Record QA evidence**

Report the checked routes/viewports, any screenshots captured, and observed scroll dimensions in the final handoff. Do not write into the user's existing `design-qa.md`.

### Task 7: Final verification and scope audit

**Files:**
- Read all modified files and git history

- [ ] **Step 1: Run final Web checks from a fresh command**

```bash
pnpm --filter @aiops/web typecheck
pnpm --filter @aiops/web build
```

Expected: both exit 0.

- [ ] **Step 2: Audit commits and remaining user work**

```bash
git log --oneline -8
git status --short
git diff --check
git diff --name-status <NAV_BASE_SHA>..HEAD
git diff --stat <NAV_BASE_SHA>..HEAD
```

Replace `<NAV_BASE_SHA>` with the exact hash recorded in Task 1. Expected: the commit-range name/status and stat contain only the four task commits and the task-owned files/hunks listed above. Pre-existing user changes remain present and unstaged. No `.superpowers/`, favicon, `ProjectIcon.vue`, `design-qa.md`, `learn/`, or unrelated API files were accidentally committed.

- [ ] **Step 3: Compare implementation to the approved spec**

Re-read:

```bash
sed -n '1,240p' docs/superpowers/specs/2026-07-22-global-context-navigation-design.md
```

Expected: all completion criteria in §11 are met, including mobile parity and browser QA records.
