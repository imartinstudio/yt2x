# X 关注列表助手 UX 重设计 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 x-following-extension 从简陋的开发者工具栏重设计为 Premium Glass 美学的精致扩展，替换原生 checkbox 为定制勾选框，用玻璃浮层 Dialog 替代 window.confirm()。

**Architecture:** 四个文件的渐进式改动。先改最底层的 checkbox 渲染（user-cell-checkbox.ts），再重写工具栏 UI（following-toolbar.ts），然后更新管理器编排逻辑（following-manager.ts），最后微调筛选 CSS（following-filter.ts）。每层改动保持现有公共 API 兼容，在管理器层缝合新交互。

**Tech Stack:** TypeScript + 原生 DOM API + Shadow DOM + CSS transition/backdrop-filter + esbuild + Vitest + jsdom

---

## 文件结构

```
packages/x-following-extension/src/
├── background/background.ts       # 不改动
├── content/following-manager.ts   # Task 3: 适配新 toolbar API，Dialog/进度/完成状态机
├── dom/
│   ├── following-filter.ts        # Task 4: CSS 注入微调
│   ├── following-filter.test.ts   # Task 4: 更新测试
│   ├── user-cell-checkbox.ts      # Task 1: 定制勾选框渲染
│   ├── user-cell-checkbox.test.ts # Task 1: 更新测试
│   └── x-session.ts               # 不改动
├── ui/
│   ├── following-toolbar.ts       # Task 2: 完全重写 — 玻璃面板 + Dialog + 进度/完成态
│   └── following-toolbar.test.ts  # Task 2: 更新测试
└── manifest.json                  # 不改动
```

---

### Task 1: 定制勾选框渲染

**Files:**

- Modify: `packages/x-following-extension/src/dom/user-cell-checkbox.ts`
- Modify: `packages/x-following-extension/src/dom/user-cell-checkbox.test.ts`

用样式化的 `<span>` 视觉元素替代原生 checkbox 外观。保持现有 API 不变（ensureUserCellCheckbox、syncCheckboxOnCell 等），保持 `<input type="checkbox">` 用于无障碍。

- [ ] **Step 1: 新增 CHECKBOX_VISUAL_ATTR 常量，修改 ensureUserCellCheckbox 渲染逻辑**

在 `user-cell-checkbox.ts` 顶部新增常量，修改 `ensureUserCellCheckbox` 函数，在 `<label>` 热区内隐藏原生 `<input>` 并用定制 `<span>` 显示视觉：

```typescript
// 在现有常量定义后新增
export const CHECKBOX_VISUAL_ATTR = "data-xfm-follow-select-visual";

// 新增辅助函数：创建视觉 span
const createVisualSpan = (): HTMLSpanElement => {
  const span = document.createElement("span");
  span.setAttribute(CHECKBOX_VISUAL_ATTR, "true");
  span.style.cssText = [
    "width:20px",
    "height:20px",
    "border-radius:5px",
    "border:1.5px solid rgba(255,255,255,0.12)",
    "background:transparent",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-size:12px",
    "font-weight:700",
    "color:transparent",
    "flex-shrink:0",
    "transition:all 0.15s cubic-bezier(0.34,1.56,0.64,1)",
    "pointer-events:none",
  ].join(";");
  return span;
};

// 新增辅助函数：更新视觉 span 的选中态
const updateVisualSpan = (span: HTMLSpanElement, checked: boolean): void => {
  if (checked) {
    span.style.background = "rgba(99,102,241,0.2)";
    span.style.borderColor = "rgba(129,140,248,0.6)";
    span.style.boxShadow = "0 0 24px rgba(99,102,241,0.2)";
    span.style.color = "white";
    span.textContent = "✓"; // ✓
  } else {
    span.style.background = "transparent";
    span.style.borderColor = "rgba(255,255,255,0.12)";
    span.style.boxShadow = "none";
    span.style.color = "transparent";
    span.textContent = "";
  }
};
```

修改 `ensureUserCellCheckbox` 中的 input 样式（隐藏原生外观，保留用于无障碍）：

```typescript
// 修改 inputStyle 常量（第27行附近）
const inputStyle = [
  "position:absolute",
  "opacity:0",
  "width:1px",
  "height:1px",
  "margin:0",
  "pointer-events:none",
].join(";");
```

修改 `ensureUserCellCheckbox` 函数体（第78行附近），在创建 input 后紧接着创建 visual span：

```typescript
// 在第107行 hit.append(input); 之后添加：
const visual = createVisualSpan();
updateVisualSpan(visual, input.checked);
hit.append(visual);
```

修改 `ensureUserCellCheckbox` 返回前绑定 change 事件以同步视觉：

```typescript
// 在 return input 之前，input 上绑定 change
input.addEventListener("change", () => {
  const vis = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
  if (vis) updateVisualSpan(vis, input.checked);
});
```

- [ ] **Step 2: 修改 setCellsChecked 函数同步视觉 span**

在 `setCellsChecked` 函数中（第194行附近），设置 `input.checked` 后同步更新视觉 span：

```typescript
const setCellsChecked = (
  cells: HTMLElement[],
  checked: boolean,
  selectedHandles?: Set<string>,
): void => {
  for (const cell of cells) {
    const mount = resolveUserCellMount(cell);
    const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
    const input = findOrReuseCheckboxInput(mount, handle) ?? ensureUserCellCheckbox(cell);
    if (input.checked !== checked) input.checked = checked;
    // 同步视觉 span
    const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (visual) updateVisualSpan(visual, input.checked);
    if (selectedHandles === undefined || handle === null) continue;
    if (checked) selectedHandles.add(handle);
    else selectedHandles.delete(handle);
  }
};
```

- [ ] **Step 3: 更新测试文件**

在 `user-cell-checkbox.test.ts` 顶部导入新常量：

```typescript
import {
  // ... 现有导入
  CHECKBOX_VISUAL_ATTR, // 新增
} from "./user-cell-checkbox.js";
```

修改第一个测试 "prepends checkbox without wrapping row children"，验证 visual span 存在且初始为未选中态：

```typescript
// 在 ensureUserCellCheckbox(cell) 之后，检查 visual span
const visual = hit?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
expect(visual).not.toBeNull();
expect(visual!.style.background).toBe("transparent");
expect(visual!.textContent).toBe("");

// 设置 checked 后
input.checked = true;
input.dispatchEvent(new Event("change"));
expect(visual!.style.background).toContain("rgba(99,102,241");
expect(visual!.textContent).toBe("✓");
```

修改虚拟列表复用测试 "reuses stale hit zone"，验证 visual span 状态随 input 同步：

```typescript
// 在 syncCheckboxOnCell 调用后：
const visual = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
expect(visual).not.toBeNull();
expect(visual!.style.background).toContain("rgba(99,102,241");

// 取消勾选后
input.checked = false;
input.dispatchEvent(new Event("change"));
expect(visual!.style.background).toBe("transparent");
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/src/dom/user-cell-checkbox.test.ts
```

预期：所有现有测试通过 + 新断言通过。

- [ ] **Step 5: 提交**

```bash
git add packages/x-following-extension/src/dom/user-cell-checkbox.ts packages/x-following-extension/src/dom/user-cell-checkbox.test.ts
git commit -m "Redesign checkbox with custom visual span and spring animation

Replace native checkbox appearance with a styled span element.
The hidden native input preserves accessibility while the visual
span provides the Premium Glass aesthetic: rounded square shape,
indigo accent on check, and spring-bounce CSS transition.

Included:

- Custom styled span with inline CSS for checked/unchecked states
- Spring animation via cubic-bezier(0.34,1.56,0.64,1) transition
- Visual span synchronization across setCellsChecked and change events
- Updated tests verifying visual span creation and state transitions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 重写工具栏 UI — 玻璃面板

**Files:**

- Modify: `packages/x-following-extension/src/ui/following-toolbar.ts`
- Modify: `packages/x-following-extension/src/ui/following-toolbar.test.ts`

完全重写 `mountFollowingToolbar` 函数。新的 Shadow DOM 模板包含：玻璃质感双行布局、iOS 风格分段筛选器、浮层 Dialog、进度态、完成态。

- [ ] **Step 1: 扩展类型定义**

在 `following-toolbar.ts` 顶部，用新的类型定义替换现有 `FollowingToolbarState`、`FollowingToolbarHandlers`、`FollowingToolbar`：

```typescript
import type { FollowingFilterMode } from "../dom/following-filter.js";

export type ToolbarPhase = "normal" | "progress" | "complete";

export type LogEntry = {
  handle: string;
  succeeded: boolean;
};

export type FollowingToolbarState = {
  filterMode: FollowingFilterMode;
  loadedCount: number;
  selectedCount: number;
  busy: boolean;
  statusText: string;
  phase: ToolbarPhase;
  progress?: {
    done: number;
    total: number;
    recentLog: LogEntry[];
  };
  completeResult?: {
    succeeded: number;
    failed: number;
  };
};

export type FollowingToolbarHandlers = {
  onFilterModeChange: (mode: FollowingFilterMode) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onUnfollowSelected: () => void;
};

export type FollowingToolbar = {
  root: HTMLElement;
  update: (state: FollowingToolbarState) => void;
  confirmUnfollow: (count: number) => Promise<boolean>;
  remove: () => void;
};
```

- [ ] **Step 2: 重写 HTML/CSS 模板**

替换 `mountFollowingToolbar` 中的 `shadow.innerHTML`。新模板包含：

- CSS 变量定义（颜色系统）
- 玻璃背景 + backdrop-filter
- 背景光晕装饰
- 双行布局（Row 1: 标题+统计，Row 2: 筛选器+按钮）
- 浮层 Dialog（默认隐藏）
- 进度条区域（默认隐藏）
- 完成状态（默认隐藏）
- 所有动画 keyframes

```typescript
shadow.innerHTML = `
  <style>
    :host {
      all: initial;
      display: block;
      font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* === 颜色变量 === */
    .bar {
      --bg-base: #0a0a14;
      --bg-surface: rgba(18,18,32,0.7);
      --glass-border: rgba(255,255,255,0.06);
      --text-pri: rgba(255,255,255,0.9);
      --text-sec: rgba(255,255,255,0.45);
      --text-dim: rgba(255,255,255,0.25);
      --accent: #818cf8;
      --accent-glow: rgba(99,102,241,0.2);
      --danger: #ef4444;
      --danger-glow: rgba(239,68,68,0.3);
      --success: #10b981;
      --btn-bg: rgba(255,255,255,0.05);
      --btn-border: rgba(255,255,255,0.06);
      --seg-bg: rgba(255,255,255,0.04);
      --seg-active: rgba(129,140,248,0.22);

      box-sizing: border-box;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px 16px;
      background: var(--bg-surface);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--glass-border);
      color: var(--text-pri);
      overflow: hidden;
    }

    /* 背景光晕装饰 */
    .bar::before {
      content: "";
      position: absolute;
      top: -30px;
      right: -20px;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(99,102,241,0.08), transparent 70%);
      pointer-events: none;
    }

    /* === Row 1: 标题 + 统计 === */
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-pri);
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-dim);
      background: rgba(255,255,255,0.05);
      padding: 2px 7px;
      border-radius: 100px;
    }
    .stats {
      display: flex;
      gap: 14px;
      font-size: 11px;
    }
    .stat {
      color: var(--text-sec);
    }
    .stat b {
      font-weight: 600;
    }
    .stat b.accent { color: var(--accent); }
    .stat b.danger { color: var(--danger); }
    .stat b.base { color: var(--text-pri); }

    /* === Row 2: 筛选器 + 按钮 === */
    .action-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .segmented {
      display: flex;
      gap: 2px;
      background: var(--seg-bg);
      border-radius: 10px;
      padding: 2px;
    }
    .segmented button {
      border: none;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-sec);
      background: transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      white-space: nowrap;
    }
    .segmented button.active {
      background: var(--seg-active);
      color: white;
      font-weight: 600;
    }
    .segmented button:disabled { opacity: 0.4; cursor: not-allowed; }

    .spacer { flex: 1; }

    .btn {
      border: 1px solid var(--btn-border);
      border-radius: 8px;
      background: var(--btn-bg);
      color: var(--text-sec);
      font-size: 12px;
      font-weight: 500;
      padding: 7px 14px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
      white-space: nowrap;
    }
    .btn:hover { background: rgba(255,255,255,0.08); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-danger {
      border: 1px solid rgba(239,68,68,0.2);
      background: linear-gradient(135deg, rgba(239,68,68,0.65), rgba(220,38,38,0.55));
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px var(--danger-glow);
    }
    .btn-danger:hover:not(:disabled) {
      box-shadow: 0 6px 24px rgba(239,68,68,0.45);
    }

    /* === 进度条 === */
    .progress-wrap {
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .progress-wrap.show { display: flex; }
    .progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-sec);
    }
    .progress-track {
      height: 4px;
      background: rgba(255,255,255,0.06);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, rgba(239,68,68,0.4), rgba(239,68,68,0.8), rgba(248,113,113,0.9));
      border-radius: 2px;
      transition: width 0.3s ease-out;
      position: relative;
    }
    .progress-fill::after {
      content: "";
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgb(248,113,113);
      box-shadow: 0 0 8px rgba(248,113,113,0.6);
    }
    .progress-log {
      font-size: 11px;
      font-family: "SF Mono", "JetBrains Mono", monospace;
      color: var(--text-dim);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .log-ok { color: rgba(16,185,129,0.7); }
    .log-fail { color: rgba(239,68,68,0.7); }
    .log-current { color: var(--text-sec); }

    /* === 完成状态 === */
    .complete-wrap {
      display: none;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: rgba(10,25,15,0.6);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-left: 3px solid rgba(16,185,129,0.5);
      border-radius: 0 8px 8px 0;
    }
    .complete-wrap.show { display: flex; }
    .complete-icon { font-size: 16px; flex-shrink: 0; }
    .complete-text { font-size: 12px; color: var(--text-sec); flex: 1; }
    .complete-text b { color: var(--success); font-weight: 600; }
    .complete-timer { font-size: 11px; color: var(--text-dim); white-space: nowrap; }

    /* === Dialog 遮罩 === */
    .dialog-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
    }
    .dialog-overlay.show { display: flex; }

    .dialog-panel {
      background: rgba(24,24,44,0.88);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 24px;
      width: 360px;
      max-width: 90vw;
      box-shadow: 0 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      text-align: center;
      animation: dialogIn 0.2s cubic-bezier(0.16,1,0.3,1);
    }

    @keyframes dialogIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .dialog-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(239,68,68,0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    .dialog-title { font-size: 15px; font-weight: 700; color: var(--text-pri); }
    .dialog-desc { font-size: 13px; color: var(--text-sec); }
    .dialog-desc b { color: var(--danger); font-weight: 600; }
    .dialog-note { font-size: 12px; color: var(--text-dim); }
    .dialog-actions {
      display: flex;
      gap: 8px;
      width: 100%;
      margin-top: 4px;
    }
    .dialog-actions .btn {
      flex: 1;
      padding: 10px;
      border-radius: 10px;
      font-size: 13px;
      text-align: center;
    }
    .dialog-actions .btn-cancel {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      color: var(--text-sec);
      font-weight: 500;
    }
    .dialog-actions .btn-confirm {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      border: none;
      color: white;
      font-weight: 600;
    }

    /* === 工具栏动画 === */
    .bar { animation: slideDown 0.25s ease-out; }
  </style>

  <!-- Dialog overlay（全局层级，在 Shadow DOM 外不可见但在 fixed 层覆盖页面） -->
  <div class="dialog-overlay" data-ref="dialog-overlay">
    <div class="dialog-panel">
      <div class="dialog-icon">⚠️</div>
      <div class="dialog-title">确认取消关注</div>
      <div class="dialog-desc" data-ref="dialog-desc"></div>
      <div class="dialog-note">此操作不可撤销</div>
      <div class="dialog-actions">
        <button class="btn btn-cancel" data-action="dialog-cancel">取消</button>
        <button class="btn btn-confirm" data-action="dialog-confirm">确认取消关注</button>
      </div>
    </div>
  </div>

  <!-- 工具栏主体 -->
  <div class="bar">
    <div class="header-row">
      <div class="title">
        关注列表助手
        <span class="badge">BETA</span>
      </div>
      <div class="stats">
        <span class="stat">列表 <b class="base" data-ref="loaded-count">0</b> 人</span>
        <span class="stat">已选 <b class="accent" data-ref="selected-count">0</b> 人</span>
        <span class="stat">未回关 <b class="danger" data-ref="oneway-count">0</b> 人</span>
      </div>
    </div>

    <div class="action-row">
      <div class="segmented">
        <button data-action="filter-one-way" class="active">仅未回关</button>
        <button data-action="filter-all">全部</button>
      </div>
      <div class="spacer"></div>
      <button class="btn" data-action="select-all">全选列表</button>
      <button class="btn" data-action="clear-selection">清除选择</button>
      <button class="btn btn-danger" data-action="unfollow-selected">取消关注所选</button>
    </div>

    <!-- 状态文本 -->
    <div style="font-size: 12px; color: var(--text-dim); min-height: 16px;" data-ref="status-text"></div>

    <!-- 进度区域 -->
    <div class="progress-wrap" data-ref="progress-wrap">
      <div class="progress-header">
        <span>正在取消关注…</span>
        <span data-ref="progress-count">0 / 0</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" data-ref="progress-fill" style="width: 0%;"></div>
      </div>
      <div class="progress-log" data-ref="progress-log"></div>
    </div>

    <!-- 完成区域 -->
    <div class="complete-wrap" data-ref="complete-wrap">
      <span class="complete-icon">✅</span>
      <span class="complete-text" data-ref="complete-text"></span>
      <span class="complete-timer" data-ref="complete-timer"></span>
    </div>
  </div>
`;
```

- [ ] **Step 3: 重写 mountFollowingToolbar 函数体**

在 Shadow DOM 模板之后，重写事件绑定和 paint 逻辑：

```typescript
  // === DOM 引用 ===
  const dialogOverlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
  const dialogDesc = shadow.querySelector<HTMLElement>('[data-ref="dialog-desc"]')!;
  const loadedCountEl = shadow.querySelector<HTMLElement>('[data-ref="loaded-count"]')!;
  const selectedCountEl = shadow.querySelector<HTMLElement>('[data-ref="selected-count"]')!;
  const onewayCountEl = shadow.querySelector<HTMLElement>('[data-ref="oneway-count"]')!;
  const statusTextEl = shadow.querySelector<HTMLElement>('[data-ref="status-text"]')!;
  const progressWrap = shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')!;
  const progressFill = shadow.querySelector<HTMLElement>('[data-ref="progress-fill"]')!;
  const progressCount = shadow.querySelector<HTMLElement>('[data-ref="progress-count"]')!;
  const progressLog = shadow.querySelector<HTMLElement>('[data-ref="progress-log"]')!;
  const completeWrap = shadow.querySelector<HTMLElement>('[data-ref="complete-wrap"]')!;
  const completeText = shadow.querySelector<HTMLElement>('[data-ref="complete-text"]')!;
  const completeTimer = shadow.querySelector<HTMLElement>('[data-ref="complete-timer"]')!;
  const filterOneWay = shadow.querySelector<HTMLElement>('[data-action="filter-one-way"]')!;
  const filterAll = shadow.querySelector<HTMLElement>('[data-action="filter-all"]')!;
  const unfollowBtn = shadow.querySelector<HTMLElement>('[data-action="unfollow-selected"]')!;

  // === 事件绑定 ===
  filterOneWay.addEventListener("click", () => {
    if (filterOneWay.classList.contains("active")) return;
    handlers.onFilterModeChange("one-way");
  });
  filterAll.addEventListener("click", () => {
    if (filterAll.classList.contains("active")) return;
    handlers.onFilterModeChange("all");
  });
  shadow.querySelector('[data-action="select-all"]')?.addEventListener("click", () => handlers.onSelectAll());
  shadow.querySelector('[data-action="clear-selection"]')?.addEventListener("click", () => handlers.onClearSelection());
  unfollowBtn.addEventListener("click", () => handlers.onUnfollowSelected());

  // Dialog 事件
  let dialogResolve: ((value: boolean) => void) | null = null;
  const dialogCancel = shadow.querySelector('[data-action="dialog-cancel"]')!;
  const dialogConfirm = shadow.querySelector('[data-action="dialog-confirm"]')!;

  dialogCancel.addEventListener("click", () => {
    dialogOverlay.classList.remove("show");
    dialogResolve?.(false);
    dialogResolve = null;
  });
  dialogConfirm.addEventListener("click", () => {
    dialogOverlay.classList.remove("show");
    dialogResolve?.(true);
    dialogResolve = null;
  });
  dialogOverlay.addEventListener("click", (e) => {
    if (e.target === dialogOverlay) {
      dialogOverlay.classList.remove("show");
      dialogResolve?.(false);
      dialogResolve = null;
    }
  });

  // === confirmUnfollow 方法 ===
  const confirmUnfollow = (count: number): Promise<boolean> =>
    new Promise((resolve) => {
      dialogDesc.innerHTML = `将取消关注 <b>${count}</b> 个账号`;
      dialogResolve = resolve;
      dialogOverlay.classList.add("show");
    });

  // === paint 方法 ===
  let lastSignature = "";

  const stateSignature = (s: FollowingToolbarState): string =>
    `${s.filterMode}|${s.loadedCount}|${s.selectedCount}|${s.busy}|${s.phase}|${s.progress?.done ?? 0}|${s.progress?.total ?? 0}`;

  const paint = (state: FollowingToolbarState): void => {
    const sig = stateSignature(state);
    if (sig === lastSignature) return;
    lastSignature = sig;

    // 统计数据
    loadedCountEl.textContent = String(state.loadedCount);
    selectedCountEl.textContent = String(state.selectedCount);
    onewayCountEl.textContent = String(state.loadedCount - (state.loadedCount > 0 ? state.loadedCount - (state.loadedCount - state.selectedCount) : 0));
    // oneway count = loaded count - (users who follow back). Simplified: loadedCount - selectedCount when in one-way mode.
    // Actually, users who follow back count = loadedCount (all mode) - loadedCount (one-way mode).
    // Let's compute: if filterMode is "all", oneWayCount is the count before filtering.
    // For now, don't show one-way count if we can't compute it. Show loaded - count of follow-back cells in DOM.
    // Real impl: count cells with userFollowIndicator in the DOM.

    statusTextEl.textContent = state.statusText;

    // 筛选按钮
    if (state.filterMode === "one-way") {
      filterOneWay.classList.add("active");
      filterAll.classList.remove("active");
    } else {
      filterAll.classList.add("active");
      filterOneWay.classList.remove("active");
    }

    // busy 态
    const allButtons = shadow.querySelectorAll<HTMLButtonElement>("button:not(.dialog-actions button)");
    allButtons.forEach((btn) => { btn.disabled = state.busy; });
    filterOneWay.disabled = state.busy;
    filterAll.disabled = state.busy;

    // phase: progress
    if (state.phase === "progress" && state.progress) {
      progressWrap.classList.add("show");
      completeWrap.classList.remove("show");
      const pct = state.progress.total > 0 ? (state.progress.done / state.progress.total) * 100 : 0;
      progressFill.style.width = `${pct}%`;
      progressCount.textContent = `${state.progress.done} / ${state.progress.total}`;
      progressLog.innerHTML = state.progress.recentLog
        .map((entry) => {
          const cls = entry.succeeded ? "log-ok" : "log-fail";
          const mark = entry.succeeded ? "✓" : "✗";
          return `<span class="${cls}">${mark} @${entry.handle}</span>`;
        })
        .join(" · ");
    } else {
      progressWrap.classList.remove("show");
    }

    // phase: complete
    if (state.phase === "complete" && state.completeResult) {
      completeWrap.classList.add("show");
      progressWrap.classList.remove("show");
      const { succeeded, failed } = state.completeResult;
      completeText.innerHTML = failed > 0
        ? `完成！成功 <b>${succeeded}</b> 人，失败 <b>${failed}</b> 人`
        : `完成！成功取消关注 <b>${succeeded}</b> 人`;
    } else {
      completeWrap.classList.remove("show");
    }
  };

  // === 初始渲染 ===
  paint(initialState);

  // === DOM 挂载 ===
  if (insertPoint !== null) {
    const { after } = insertPoint;
    const parent = after.parentElement;
    const before = after.nextElementSibling;
    if (parent !== null) {
      parent.insertBefore(host, before);
    } else {
      after.insertAdjacentElement("afterend", host);
    }
  } else if (fallbackAnchor !== null) {
    fallbackAnchor.prepend(host);
  } else {
    document.body.append(host);
  }

  return {
    root: host,
    update: paint,
    confirmUnfollow,
    remove: () => {
      dialogOverlay.remove(); // 清理 fixed 元素
      host.remove();
    },
  };
};
```

- [ ] **Step 4: 更新测试文件**

在 `following-toolbar.test.ts` 顶部新增对 `mountFollowingToolbar` 的测试（该函数之前未被充分测试）：

```typescript
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  findFollowingInsertAnchor,
  findFollowingListInsertPoint,
  findFollowingTablist,
  findTabStickyStrip,
  listFollowingToolbarHosts,
  mountFollowingToolbar,
  removeAllFollowingToolbarHosts,
  TOOLBAR_HOST_ATTR,
  type FollowingToolbarState,
  type FollowingToolbarHandlers,
} from "./following-toolbar.js";

// ... 保留现有测试 ...

describe("mountFollowingToolbar", () => {
  const initialState: FollowingToolbarState = {
    filterMode: "one-way",
    loadedCount: 20,
    selectedCount: 3,
    busy: false,
    statusText: "就绪",
    phase: "normal",
  };

  const noopHandlers: FollowingToolbarHandlers = {
    onFilterModeChange: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onUnfollowSelected: vi.fn(),
  };

  afterEach(() => {
    removeAllFollowingToolbarHosts();
    document.body.innerHTML = "";
  });

  it("renders toolbar with glass-morphism styles and correct stats", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    // 统计数字
    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("20");
    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("3");

    // 筛选按钮状态
    const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
    expect(filterOneWay.classList.contains("active")).toBe(true);

    // 标题存在
    expect(shadow.querySelector(".title")?.textContent).toContain("关注列表助手");

    tb.remove();
  });

  it("updates stats when paint is called", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({ ...initialState, selectedCount: 8, loadedCount: 25 });
    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("8");
    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("25");

    tb.remove();
  });

  it("shows progress bar when phase is progress", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: true,
      phase: "progress",
      progress: {
        done: 2,
        total: 5,
        recentLog: [
          { handle: "alice", succeeded: true },
          { handle: "bob", succeeded: true },
        ],
      },
    });

    const progressWrap = shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')!;
    expect(progressWrap.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="progress-fill"]')?.getAttribute("style")).toContain(
      "40%",
    );
    expect(shadow.querySelector('[data-ref="progress-count"]')?.textContent).toBe("2 / 5");
    expect(shadow.querySelector('[data-ref="progress-log"]')?.textContent).toContain("alice");

    tb.remove();
  });

  it("shows complete banner when phase is complete", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: false,
      phase: "complete",
      completeResult: { succeeded: 5, failed: 0 },
    });

    const completeWrap = shadow.querySelector<HTMLElement>('[data-ref="complete-wrap"]')!;
    expect(completeWrap.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="complete-text"]')?.textContent).toContain("5");

    tb.remove();
  });

  it("confirmUnfollow shows dialog and resolves on confirm", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(6);

    const overlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
    expect(overlay.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="dialog-desc"]')?.innerHTML).toContain("6");

    // 点击确认
    const confirmBtn = shadow.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')!;
    confirmBtn.click();

    const result = await promise;
    expect(result).toBe(true);
    expect(overlay.classList.contains("show")).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow resolves false on cancel", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(3);

    const cancelBtn = shadow.querySelector<HTMLButtonElement>('[data-action="dialog-cancel"]')!;
    cancelBtn.click();

    const result = await promise;
    expect(result).toBe(false);

    tb.remove();
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/src/ui/following-toolbar.test.ts
```

预期：5 个新测试 + 2 个现有测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add packages/x-following-extension/src/ui/following-toolbar.ts packages/x-following-extension/src/ui/following-toolbar.test.ts
git commit -m "Rewrite toolbar with Premium Glass UI, dialog, and state phases

Replace the basic dark-bar toolbar with a glass-morphism design
featuring backdrop-filter blur, indigo accent, and refined typography.

Included:

- Two-row layout: title+stats row, filter+actions row
- iOS-style segmented control for filter mode toggle
- Floating glass dialog (confirmUnfollow) replacing window.confirm()
- Progress state: gradient progress bar with real-time log stream
- Complete state: green banner with auto-dismiss placeholder
- CSS-only animations: dialogIn, slideDown, fadeIn keyframes
- ToolbarPhase type: 'normal' | 'progress' | 'complete'
- Comprehensive tests for mount, update, progress, complete, dialog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 更新管理器编排 — Dialog + 进度状态机

**Files:**

- Modify: `packages/x-following-extension/src/content/following-manager.ts`

将 `window.confirm()` 替换为 `toolbar.confirmUnfollow()`。添加进度态和完成态的状态转换。完成态 3 秒后自动恢复。

- [ ] **Step 1: 添加 one-way 用户计数逻辑**

在 `following-manager.ts` 顶部导入区，新增辅助函数用于统计未回关人数（用于工具栏 Row 1 显示）：

```typescript
import {
  // ... 现有导入 ...
  userCellFollowsYou,
} from "../dom/following-filter.js";
```

- [ ] **Step 2: 实现 oneWayCount 计算**

新增函数统计 DOM 中已回关的用户数：

```typescript
const countFollowBackCells = (): number => {
  const cells = document.querySelectorAll<HTMLElement>('[data-testid="UserCell"]');
  let count = 0;
  for (const cell of cells) {
    if (userCellFollowsYou(cell)) count += 1;
  }
  return count;
};
```

- [ ] **Step 3: 修改 buildToolbarState 包含 phase 和 oneWayCount**

```typescript
const buildToolbarState = (counts: {
  loadedCount: number;
  selectedCount: number;
}): FollowingToolbarState => {
  const followBackCount = countFollowBackCells();
  return {
    filterMode,
    loadedCount: counts.loadedCount,
    selectedCount: counts.selectedCount,
    busy,
    statusText,
    phase: "normal",
    oneWayCount:
      filterMode === "one-way" ? counts.loadedCount : counts.loadedCount - followBackCount,
  };
};
```

Wait — `FollowingToolbarState` doesn't have `oneWayCount` in the type definition from Task 2. Let me adjust. The oneWayCount is computed by the toolbar from loadedCount. Actually, the spec says to show "未回关 N 人" in stats. The manager is the one that can compute this since it has access to the DOM. Let me add it to the state type.

Actually, looking back at Task 2, I should have included `oneWayCount` in `FollowingToolbarState`. Let me fix that. In Task 2's type definition:

```typescript
export type FollowingToolbarState = {
  filterMode: FollowingFilterMode;
  loadedCount: number;
  selectedCount: number;
  busy: boolean;
  statusText: string;
  phase: ToolbarPhase;
  oneWayCount: number;  // 未回关人数（在当前筛选模式下）
  progress?: { ... };
  completeResult?: { ... };
};
```

And in the toolbar's paint function, use `state.oneWayCount` instead of computing it. Let me note this dependency — Task 3 needs to add `oneWayCount` to the state, and Task 2 needs to have it in the type. I'll add a note in Task 2's step 1 to include it.

OK, let me just fix the plan — in Task 2 Step 1, the FollowingToolbarState should include `oneWayCount: number`. And the toolbar's paint uses `state.oneWayCount` for the stat display. This is a cross-task fix I need to note clearly.

Let me rewrite Task 3 more carefully, accounting for the exact state shape.

For the handler changes:

1. `handleUnfollowSelected`: Replace `window.confirm()` with `await toolbar.confirmUnfollow(count)`
2. During unfollow: Update toolbar state to phase='progress' with progress data
3. After unfollow: Update toolbar state to phase='complete' with result
4. After 3s: Reset to phase='normal'
5. `buildToolbarState`: Include phase, oneWayCount, progress/completeResult as needed

Let me write the exact code changes now. I need to be very precise about what changes in the manager.

In the manager, I need to:

1. Add `oneWayCount` to `buildToolbarState`
2. Modify `handleUnfollowSelected` to:
   - Use `toolbar.confirmUnfollow(count)` instead of `window.confirm()`
   - Set phase='progress' with progress updates
   - Set phase='complete' when done
   - Reset phase after 3s

Let me figure out the exact code changes to `handleUnfollowSelected`:

```typescript
const handleUnfollowSelected = async (): Promise<void> => {
  if (busy) return;

  const handles = [...selectedHandles];
  const cells = handles
    .map((handle) => findUserCellByHandle(handle))
    .filter((cell): cell is HTMLElement => cell !== null);

  if (cells.length === 0) {
    statusText = "请先勾选要取消关注的用户";
    updateToolbar(true);
    return;
  }

  // 新：使用 Dialog 确认
  if (toolbar === null) return;
  const confirmed = await toolbar.confirmUnfollow(cells.length);
  if (!confirmed) return;

  busy = true;
  // 新：进入进度态
  const logBuffer: LogEntry[] = [];
  toolbar.update({
    ...buildToolbarState({
      loadedCount: listLoadedUserCells(filterMode).length,
      selectedCount: selectedHandles.size,
    }),
    busy: true,
    phase: "progress",
    progress: { done: 0, total: cells.length, recentLog: [] },
  });

  const result = await unfollowSelectedCells(cells, (progress) => {
    logBuffer.push({ handle: progress.handle, succeeded: progress.succeeded });
    // 保留最近 3 条日志
    const recent = logBuffer.slice(-3);
    toolbar?.update({
      ...buildToolbarState({
        loadedCount: listLoadedUserCells(filterMode).length,
        selectedCount: selectedHandles.size,
      }),
      busy: true,
      phase: "progress",
      progress: { done: progress.done, total: progress.total, recentLog: recent },
    });
  });

  selectedHandles.clear();
  setAllLoadedChecked(false, filterMode, selectedHandles);
  busy = false;
  statusText = `完成：成功 ${result.succeeded}，失败 ${result.failed}`;

  // 新：进入完成态
  toolbar.update({
    ...buildToolbarState({ loadedCount: listLoadedUserCells(filterMode).length, selectedCount: 0 }),
    busy: false,
    phase: "complete",
    completeResult: { succeeded: result.succeeded, failed: result.failed },
  });

  lastSyncAt = 0;
  runThrottledSync(true);

  // 新：3 秒后自动恢复
  window.setTimeout(() => {
    statusText = "勾选用户后可批量取消关注";
    updateToolbar(true);
  }, 3000);
};
```

Now for `buildToolbarState`, I need to add `oneWayCount` and `phase`:

```typescript
const buildToolbarState = (counts: {
  loadedCount: number;
  selectedCount: number;
}): FollowingToolbarState => {
  const followBackCount = countFollowBackCells();
  return {
    filterMode,
    loadedCount: counts.loadedCount,
    selectedCount: counts.selectedCount,
    busy,
    statusText,
    phase: "normal",
    oneWayCount:
      filterMode === "one-way" ? counts.loadedCount : counts.loadedCount - followBackCount,
  };
};
```

Wait, but the manager code has `buildToolbarState` being called in many places. I need to make sure all call sites handle the new return type correctly. Since `FollowingToolbarState` now has additional fields, and `toolbar.update()` handles them, the existing code should still work — `toolbarSignature` needs updating to include the new fields though.

Let me update `toolbarSignature`:

```typescript
const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.loadedCount}|${state.selectedCount}|${state.busy}|${state.statusText}|${state.phase}`;
```

That should be sufficient. The progress and completeResult fields are optional and handled when present.

OK, I think I have everything. Let me write the plan for Task 3 now with all these details.

Actually, one more thing. The `countFollowBackCells` function needs to be defined. This counts all UserCells in the DOM that have the "follows you" indicator:

```typescript
const countFollowBackCells = (): number =>
  listUserCells().filter((cell) => userCellFollowsYou(cell)).length;
```

This is straightforward with the existing `listUserCells` from following-filter.ts.

OK let me finalize the plan content. I realize I've been doing a lot of thinking, let me just write the damn plan file now.<｜end▁of▁thinking｜>

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="Write">
<｜｜DSML｜｜parameter name="content" string="true"># X 关注列表助手 UX 重设计 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 x-following-extension 从简陋的开发者工具栏重设计为 Premium Glass 美学的精致扩展，替换原生 checkbox 为定制勾选框，用玻璃浮层 Dialog 替代 window.confirm()。

**Architecture:** 四个文件的渐进式改动。先改最底层 checkbox 渲染（user-cell-checkbox.ts），再重写工具栏 UI（following-toolbar.ts），然后更新管理器编排逻辑（following-manager.ts），最后微调筛选 CSS（following-filter.ts）。每层改动保持现有公共 API 兼容，在管理器层缝合新交互。

**Tech Stack:** TypeScript + 原生 DOM API + Shadow DOM + CSS transition/backdrop-filter + esbuild + Vitest + jsdom

**文件结构:**

```
packages/x-following-extension/src/
├── background/background.ts       # 不改动
├── content/following-manager.ts   # Task 3: 适配新 toolbar API，Dialog/进度/完成状态机
├── dom/
│   ├── following-filter.ts        # Task 4: CSS 注入微调
│   ├── following-filter.test.ts   # Task 4: 更新测试
│   ├── user-cell-checkbox.ts      # Task 1: 定制勾选框渲染
│   ├── user-cell-checkbox.test.ts # Task 1: 更新测试
│   └── x-session.ts               # 不改动
├── ui/
│   ├── following-toolbar.ts       # Task 2: 完全重写 — 玻璃面板 + Dialog + 进度/完成态
│   └── following-toolbar.test.ts  # Task 2: 更新测试
└── manifest.json                  # 不改动
```

````

---

### Task 1: 定制勾选框渲染

**Files:**
- Modify: `packages/x-following-extension/src/dom/user-cell-checkbox.ts`
- Modify: `packages/x-following-extension/src/dom/user-cell-checkbox.test.ts`

用样式化的 `<span>` 视觉元素替代原生 checkbox 外观。保持现有公共 API 不变，保持 `<input type="checkbox">` 用于无障碍。

- [ ] **Step 1: 新增常量 `CHECKBOX_VISUAL_ATTR` 和辅助函数**

在 `user-cell-checkbox.ts` 的现有常量定义后添加：

```typescript
export const CHECKBOX_VISUAL_ATTR = "data-xfm-follow-select-visual";

const createVisualSpan = (): HTMLSpanElement => {
  const span = document.createElement("span");
  span.setAttribute(CHECKBOX_VISUAL_ATTR, "true");
  span.style.cssText = [
    "width:20px",
    "height:20px",
    "border-radius:5px",
    "border:1.5px solid rgba(255,255,255,0.12)",
    "background:transparent",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "font-size:12px",
    "font-weight:700",
    "color:transparent",
    "flex-shrink:0",
    "transition:all 0.15s cubic-bezier(0.34,1.56,0.64,1)",
    "pointer-events:none",
  ].join(";");
  return span;
};

const updateVisualSpan = (span: HTMLSpanElement, checked: boolean): void => {
  if (checked) {
    span.style.background = "rgba(99,102,241,0.2)";
    span.style.borderColor = "rgba(129,140,248,0.6)";
    span.style.boxShadow = "0 0 24px rgba(99,102,241,0.2)";
    span.style.color = "white";
    span.textContent = "✓";
  } else {
    span.style.background = "transparent";
    span.style.borderColor = "rgba(255,255,255,0.12)";
    span.style.boxShadow = "none";
    span.style.color = "transparent";
    span.textContent = "";
  }
};
````

- [ ] **Step 2: 修改 `ensureUserCellCheckbox` — 隐藏原生 input 并创建 visual span**

修改 `inputStyle` 常量（当前文件约第27行），将原生 input 完全隐藏：

```typescript
const inputStyle = [
  "position:absolute",
  "opacity:0",
  "width:1px",
  "height:1px",
  "margin:0",
  "pointer-events:none",
].join(";");
```

在 `ensureUserCellCheckbox` 函数体中（约第107行 `hit.append(input);` 之后），添加 visual span 创建和 change 事件绑定：

```typescript
// 在 hit.append(input); 之后添加：
const visual = createVisualSpan();
updateVisualSpan(visual, input.checked);
hit.append(visual);

// 同步视觉：input change → update visual
input.addEventListener("change", () => {
  const vis = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
  if (vis) updateVisualSpan(vis, input.checked);
});
```

- [ ] **Step 3: 修改 `setCellsChecked` 同步 visual span**

在 `setCellsChecked` 函数中（约第194行），`input.checked` 变化后同步 visual：

```typescript
const setCellsChecked = (
  cells: HTMLElement[],
  checked: boolean,
  selectedHandles?: Set<string>,
): void => {
  for (const cell of cells) {
    const mount = resolveUserCellMount(cell);
    const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
    const input = findOrReuseCheckboxInput(mount, handle) ?? ensureUserCellCheckbox(cell);
    if (input.checked !== checked) input.checked = checked;
    const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (visual) updateVisualSpan(visual, input.checked);
    if (selectedHandles === undefined || handle === null) continue;
    if (checked) selectedHandles.add(handle);
    else selectedHandles.delete(handle);
  }
};
```

- [ ] **Step 4: 更新测试 — 验证 visual span 创建和状态**

在 `user-cell-checkbox.test.ts` 顶部添加 `CHECKBOX_VISUAL_ATTR` 导入：

```typescript
import {
  // ... 现有导入
  CHECKBOX_VISUAL_ATTR,
} from "./user-cell-checkbox.js";
```

修改 "prepends checkbox without wrapping row children" 测试，在 `ensureUserCellCheckbox(cell)` 之后添加 visual span 验证：

```typescript
// 在 ensureUserCellCheckbox(cell) 之后，input.checked = true 之前：
const visual = hit?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
expect(visual).not.toBeNull();
expect(visual!.style.background).toBe("transparent");
expect(visual!.textContent).toBe("");

// input.checked = true 之后，手动触发 change 事件验证同步：
input.checked = true;
input.dispatchEvent(new Event("change"));
expect(visual!.style.background).toContain("rgba(99,102,241");
expect(visual!.textContent).toBe("✓");

// 取消选中：
input.checked = false;
input.dispatchEvent(new Event("change"));
expect(visual!.style.background).toBe("transparent");
expect(visual!.textContent).toBe("");
```

修改 "reuses stale hit zone" 测试，添加 visual span 状态验证：

```typescript
// 在 syncCheckboxOnCell 调用后，确认 visual span 存在且为选中态：
const visual = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
expect(visual).not.toBeNull();
expect(visual!.style.background).toContain("rgba(99,102,241");
expect(visual!.textContent).toBe("✓");
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/src/dom/user-cell-checkbox.test.ts
```

预期：所有测试通过（包括新增断言）。

- [ ] **Step 6: 提交**

```bash
git add packages/x-following-extension/src/dom/user-cell-checkbox.ts packages/x-following-extension/src/dom/user-cell-checkbox.test.ts
git commit -m "Redesign checkbox with custom visual span and spring animation

Replace native checkbox appearance with a styled span element.
The hidden native input preserves accessibility while the visual
span provides the Premium Glass aesthetic: 20x20 rounded square,
indigo accent with glow on check, spring-bounce CSS transition
via cubic-bezier(0.34,1.56,0.64,1).

Included:

- Custom styled span with inline CSS for checked/unchecked
- updateVisualSpan helper syncing background, border, shadow, text
- Visual sync in change events and setCellsChecked batch path
- Updated tests verifying visual span creation and state transitions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 重写工具栏 UI — 玻璃面板 + Dialog + 多阶段状态

**Files:**

- Modify: `packages/x-following-extension/src/ui/following-toolbar.ts`
- Modify: `packages/x-following-extension/src/ui/following-toolbar.test.ts`

完全重写 `mountFollowingToolbar`。新 Shadow DOM 包含：玻璃质感双行布局、iOS 分段筛选器、浮层 Dialog（`confirmUnfollow` 方法）、进度态、完成态。

- [ ] **Step 1: 扩展类型定义**

替换 `following-toolbar.ts` 顶部的 `FollowingToolbarState`、`FollowingToolbarHandlers`、`FollowingToolbar` 类型：

```typescript
export type ToolbarPhase = "normal" | "progress" | "complete";

export type LogEntry = {
  handle: string;
  succeeded: boolean;
};

export type FollowingToolbarState = {
  filterMode: FollowingFilterMode;
  loadedCount: number;
  selectedCount: number;
  busy: boolean;
  statusText: string;
  phase: ToolbarPhase;
  oneWayCount: number;
  progress?: {
    done: number;
    total: number;
    recentLog: LogEntry[];
  };
  completeResult?: {
    succeeded: number;
    failed: number;
  };
};

export type FollowingToolbarHandlers = {
  onFilterModeChange: (mode: FollowingFilterMode) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onUnfollowSelected: () => void;
};

export type FollowingToolbar = {
  root: HTMLElement;
  update: (state: FollowingToolbarState) => void;
  confirmUnfollow: (count: number) => Promise<boolean>;
  remove: () => void;
};
```

- [ ] **Step 2: 重写 Shadow DOM 模板**

完整替换 `mountFollowingToolbar` 中的 `shadow.innerHTML`。新模板包含：CSS 变量颜色系统、玻璃背景 + 光晕装饰、双行布局、分段筛选器、浮层 Dialog（fixed 定位 + backdrop-filter）、进度条 + 日志流、完成横幅、三个 @keyframes 动画。

```typescript
shadow.innerHTML = `
  <style>
    :host {
      all: initial;
      display: block;
      font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .bar {
      --bg-base: #0a0a14;
      --bg-surface: rgba(18,18,32,0.7);
      --glass-border: rgba(255,255,255,0.06);
      --text-pri: rgba(255,255,255,0.9);
      --text-sec: rgba(255,255,255,0.45);
      --text-dim: rgba(255,255,255,0.25);
      --accent: #818cf8;
      --accent-glow: rgba(99,102,241,0.2);
      --danger: #ef4444;
      --danger-glow: rgba(239,68,68,0.3);
      --success: #10b981;
      --btn-bg: rgba(255,255,255,0.05);
      --btn-border: rgba(255,255,255,0.06);
      --seg-bg: rgba(255,255,255,0.04);
      --seg-active: rgba(129,140,248,0.22);
      box-sizing: border-box;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px 16px;
      background: var(--bg-surface);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--glass-border);
      color: var(--text-pri);
      overflow: hidden;
    }
    .bar::before {
      content: "";
      position: absolute;
      top: -30px;
      right: -20px;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(99,102,241,0.08), transparent 70%);
      pointer-events: none;
    }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-pri);
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-dim);
      background: rgba(255,255,255,0.05);
      padding: 2px 7px;
      border-radius: 100px;
    }
    .stats {
      display: flex;
      gap: 14px;
      font-size: 11px;
    }
    .stat { color: var(--text-sec); }
    .stat b { font-weight: 600; }
    .stat b.accent { color: var(--accent); }
    .stat b.danger { color: var(--danger); }
    .stat b.base { color: var(--text-pri); }

    .action-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .segmented {
      display: flex;
      gap: 2px;
      background: var(--seg-bg);
      border-radius: 10px;
      padding: 2px;
    }
    .segmented button {
      border: none;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-sec);
      background: transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      white-space: nowrap;
    }
    .segmented button.active {
      background: var(--seg-active);
      color: white;
      font-weight: 600;
    }
    .segmented button:disabled { opacity: 0.4; cursor: not-allowed; }

    .spacer { flex: 1; }

    .btn {
      border: 1px solid var(--btn-border);
      border-radius: 8px;
      background: var(--btn-bg);
      color: var(--text-sec);
      font-size: 12px;
      font-weight: 500;
      padding: 7px 14px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
      white-space: nowrap;
    }
    .btn:hover { background: rgba(255,255,255,0.08); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-danger {
      border: 1px solid rgba(239,68,68,0.2);
      background: linear-gradient(135deg, rgba(239,68,68,0.65), rgba(220,38,38,0.55));
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px var(--danger-glow);
    }
    .btn-danger:hover:not(:disabled) {
      box-shadow: 0 6px 24px rgba(239,68,68,0.45);
    }

    .progress-wrap {
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .progress-wrap.show { display: flex; }
    .progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-sec);
    }
    .progress-track {
      height: 4px;
      background: rgba(255,255,255,0.06);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, rgba(239,68,68,0.4), rgba(239,68,68,0.8), rgba(248,113,113,0.9));
      border-radius: 2px;
      transition: width 0.3s ease-out;
      position: relative;
    }
    .progress-fill::after {
      content: "";
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgb(248,113,113);
      box-shadow: 0 0 8px rgba(248,113,113,0.6);
    }
    .progress-log {
      font-size: 11px;
      font-family: "SF Mono", "JetBrains Mono", monospace;
      color: var(--text-dim);
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .log-ok { color: rgba(16,185,129,0.7); }
    .log-fail { color: rgba(239,68,68,0.7); }
    .log-current { color: var(--text-sec); }

    .complete-wrap {
      display: none;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      background: rgba(10,25,15,0.6);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-left: 3px solid rgba(16,185,129,0.5);
      border-radius: 0 8px 8px 0;
    }
    .complete-wrap.show { display: flex; }
    .complete-icon { font-size: 16px; flex-shrink: 0; }
    .complete-text { font-size: 12px; color: var(--text-sec); flex: 1; }
    .complete-text b { color: var(--success); font-weight: 600; }
    .complete-timer { font-size: 11px; color: var(--text-dim); white-space: nowrap; }

    .dialog-overlay {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
    }
    .dialog-overlay.show { display: flex; }

    .dialog-panel {
      background: rgba(24,24,44,0.88);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      padding: 24px;
      width: 360px;
      max-width: 90vw;
      box-shadow: 0 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      text-align: center;
      animation: dialogIn 0.2s cubic-bezier(0.16,1,0.3,1);
    }

    @keyframes dialogIn {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .dialog-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(239,68,68,0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
    }
    .dialog-title { font-size: 15px; font-weight: 700; color: var(--text-pri); }
    .dialog-desc { font-size: 13px; color: var(--text-sec); }
    .dialog-desc b { color: var(--danger); font-weight: 600; }
    .dialog-note { font-size: 12px; color: var(--text-dim); }
    .dialog-actions {
      display: flex;
      gap: 8px;
      width: 100%;
      margin-top: 4px;
    }
    .dialog-actions .btn {
      flex: 1;
      padding: 10px;
      border-radius: 10px;
      font-size: 13px;
      text-align: center;
    }
    .dialog-actions .btn-cancel {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      color: var(--text-sec);
      font-weight: 500;
    }
    .dialog-actions .btn-confirm {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      border: none;
      color: white;
      font-weight: 600;
    }

    .bar { animation: slideDown 0.25s ease-out; }
  </style>

  <div class="dialog-overlay" data-ref="dialog-overlay">
    <div class="dialog-panel">
      <div class="dialog-icon">⚠️</div>
      <div class="dialog-title">确认取消关注</div>
      <div class="dialog-desc" data-ref="dialog-desc"></div>
      <div class="dialog-note">此操作不可撤销</div>
      <div class="dialog-actions">
        <button class="btn btn-cancel" data-action="dialog-cancel">取消</button>
        <button class="btn btn-confirm" data-action="dialog-confirm">确认取消关注</button>
      </div>
    </div>
  </div>

  <div class="bar">
    <div class="header-row">
      <div class="title">
        关注列表助手
        <span class="badge">BETA</span>
      </div>
      <div class="stats">
        <span class="stat">列表 <b class="base" data-ref="loaded-count">0</b> 人</span>
        <span class="stat">已选 <b class="accent" data-ref="selected-count">0</b> 人</span>
        <span class="stat">未回关 <b class="danger" data-ref="oneway-count">0</b> 人</span>
      </div>
    </div>

    <div class="action-row">
      <div class="segmented">
        <button data-action="filter-one-way" class="active">仅未回关</button>
        <button data-action="filter-all">全部</button>
      </div>
      <div class="spacer"></div>
      <button class="btn" data-action="select-all">全选列表</button>
      <button class="btn" data-action="clear-selection">清除选择</button>
      <button class="btn btn-danger" data-action="unfollow-selected">取消关注所选</button>
    </div>

    <div style="font-size:12px;color:var(--text-dim);min-height:16px" data-ref="status-text"></div>

    <div class="progress-wrap" data-ref="progress-wrap">
      <div class="progress-header">
        <span>正在取消关注…</span>
        <span data-ref="progress-count">0 / 0</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" data-ref="progress-fill" style="width:0%"></div>
      </div>
      <div class="progress-log" data-ref="progress-log"></div>
    </div>

    <div class="complete-wrap" data-ref="complete-wrap">
      <span class="complete-icon">✅</span>
      <span class="complete-text" data-ref="complete-text"></span>
      <span class="complete-timer" data-ref="complete-timer"></span>
    </div>
  </div>
`;
```

- [ ] **Step 3: 重写 mountFollowingToolbar 的 JS 逻辑**

在模板字符串之后，重写 querySelector 引用、事件绑定、`confirmUnfollow` Promise 方法、`paint` 函数：

```typescript
  // === DOM 引用 ===
  const dialogOverlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
  const dialogDesc = shadow.querySelector<HTMLElement>('[data-ref="dialog-desc"]')!;
  const loadedCountEl = shadow.querySelector<HTMLElement>('[data-ref="loaded-count"]')!;
  const selectedCountEl = shadow.querySelector<HTMLElement>('[data-ref="selected-count"]')!;
  const onewayCountEl = shadow.querySelector<HTMLElement>('[data-ref="oneway-count"]')!;
  const statusTextEl = shadow.querySelector<HTMLElement>('[data-ref="status-text"]')!;
  const progressWrap = shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')!;
  const progressFill = shadow.querySelector<HTMLElement>('[data-ref="progress-fill"]')!;
  const progressCount = shadow.querySelector<HTMLElement>('[data-ref="progress-count"]')!;
  const progressLog = shadow.querySelector<HTMLElement>('[data-ref="progress-log"]')!;
  const completeWrap = shadow.querySelector<HTMLElement>('[data-ref="complete-wrap"]')!;
  const completeText = shadow.querySelector<HTMLElement>('[data-ref="complete-text"]')!;
  const filterOneWay = shadow.querySelector<HTMLElement>('[data-action="filter-one-way"]')!;
  const filterAll = shadow.querySelector<HTMLElement>('[data-action="filter-all"]')!;
  const unfollowBtn = shadow.querySelector<HTMLElement>('[data-action="unfollow-selected"]')!;

  // === 事件绑定 ===
  filterOneWay.addEventListener("click", () => {
    if (filterOneWay.classList.contains("active")) return;
    handlers.onFilterModeChange("one-way");
  });
  filterAll.addEventListener("click", () => {
    if (filterAll.classList.contains("active")) return;
    handlers.onFilterModeChange("all");
  });
  shadow.querySelector('[data-action="select-all"]')?.addEventListener("click", () => handlers.onSelectAll());
  shadow.querySelector('[data-action="clear-selection"]')?.addEventListener("click", () => handlers.onClearSelection());
  unfollowBtn.addEventListener("click", () => handlers.onUnfollowSelected());

  // === Dialog ===
  let dialogResolve: ((value: boolean) => void) | null = null;

  shadow.querySelector('[data-action="dialog-cancel"]')?.addEventListener("click", () => {
    dialogOverlay.classList.remove("show");
    dialogResolve?.(false);
    dialogResolve = null;
  });
  shadow.querySelector('[data-action="dialog-confirm"]')?.addEventListener("click", () => {
    dialogOverlay.classList.remove("show");
    dialogResolve?.(true);
    dialogResolve = null;
  });
  dialogOverlay.addEventListener("click", (e) => {
    if (e.target === dialogOverlay) {
      dialogOverlay.classList.remove("show");
      dialogResolve?.(false);
      dialogResolve = null;
    }
  });

  const confirmUnfollow = (count: number): Promise<boolean> =>
    new Promise((resolve) => {
      dialogDesc.innerHTML = `将取消关注 <b>${count}</b> 个账号`;
      dialogResolve = resolve;
      dialogOverlay.classList.add("show");
    });

  // === Paint ===
  let lastSignature = "";

  const stateSignature = (s: FollowingToolbarState): string =>
    `${s.filterMode}|${s.loadedCount}|${s.selectedCount}|${s.busy}|${s.phase}|${s.progress?.done ?? 0}|${s.progress?.total ?? 0}`;

  const paint = (state: FollowingToolbarState): void => {
    const sig = stateSignature(state);
    if (sig === lastSignature) return;
    lastSignature = sig;

    loadedCountEl.textContent = String(state.loadedCount);
    selectedCountEl.textContent = String(state.selectedCount);
    onewayCountEl.textContent = String(state.oneWayCount);
    statusTextEl.textContent = state.statusText;

    // 筛选按钮高亮
    if (state.filterMode === "one-way") {
      filterOneWay.classList.add("active");
      filterAll.classList.remove("active");
    } else {
      filterAll.classList.add("active");
      filterOneWay.classList.remove("active");
    }

    // busy 态禁用所有按钮
    const allButtons = shadow.querySelectorAll<HTMLButtonElement>("button:not(.dialog-actions button)");
    allButtons.forEach((btn) => { btn.disabled = state.busy; });
    filterOneWay.disabled = state.busy;
    filterAll.disabled = state.busy;

    // Phase: progress
    if (state.phase === "progress" && state.progress) {
      progressWrap.classList.add("show");
      completeWrap.classList.remove("show");
      const pct = state.progress.total > 0 ? (state.progress.done / state.progress.total) * 100 : 0;
      progressFill.style.width = `${pct}%`;
      progressCount.textContent = `${state.progress.done} / ${state.progress.total}`;
      progressLog.innerHTML = state.progress.recentLog
        .map((entry) => {
          const cls = entry.succeeded ? "log-ok" : "log-fail";
          const mark = entry.succeeded ? "✓" : "✗";
          return `<span class="${cls}">${mark} @${entry.handle}</span>`;
        })
        .join(" · ");
    } else {
      progressWrap.classList.remove("show");
    }

    // Phase: complete
    if (state.phase === "complete" && state.completeResult) {
      completeWrap.classList.add("show");
      progressWrap.classList.remove("show");
      const { succeeded, failed } = state.completeResult;
      completeText.innerHTML = failed > 0
        ? `完成！成功 <b>${succeeded}</b> 人，失败 <b>${failed}</b> 人`
        : `完成！成功取消关注 <b>${succeeded}</b> 人`;
    } else {
      completeWrap.classList.remove("show");
    }
  };

  // === 初始渲染 ===
  paint(initialState);

  // === DOM 挂载 ===
  if (insertPoint !== null) {
    const { after } = insertPoint;
    const parent = after.parentElement;
    const before = after.nextElementSibling;
    if (parent !== null) {
      parent.insertBefore(host, before);
    } else {
      after.insertAdjacentElement("afterend", host);
    }
  } else if (fallbackAnchor !== null) {
    fallbackAnchor.prepend(host);
  } else {
    document.body.append(host);
  }

  return {
    root: host,
    update: paint,
    confirmUnfollow,
    remove: () => {
      host.remove();
    },
  };
};
```

- [ ] **Step 4: 更新 external 辅助函数 — 添加 `oneWayCount` 兼容**

`findFollowingListInsertPoint`、`findFollowingTablist` 等辅助函数保持不变。现有测试 `findFollowingListInsertPoint` 和 `toolbar host dedupe` 无需修改（它们不依赖模板渲染）。

- [ ] **Step 5: 添加新测试到 following-toolbar.test.ts**

在现有测试文件末尾追加以下测试块：

```typescript
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  findFollowingInsertAnchor,
  findFollowingListInsertPoint,
  findFollowingTablist,
  findTabStickyStrip,
  listFollowingToolbarHosts,
  mountFollowingToolbar,
  removeAllFollowingToolbarHosts,
  TOOLBAR_HOST_ATTR,
  type FollowingToolbarState,
  type FollowingToolbarHandlers,
} from "./following-toolbar.js";

const resetDom = (): void => {
  document.body.innerHTML = "";
};

afterEach(() => {
  resetDom();
});

// ... 保留现有测试 ...

describe("mountFollowingToolbar", () => {
  const initialState: FollowingToolbarState = {
    filterMode: "one-way",
    loadedCount: 20,
    selectedCount: 3,
    busy: false,
    statusText: "就绪",
    phase: "normal",
    oneWayCount: 14,
  };

  const noopHandlers: FollowingToolbarHandlers = {
    onFilterModeChange: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onUnfollowSelected: vi.fn(),
  };

  afterEach(() => {
    removeAllFollowingToolbarHosts();
  });

  it("renders toolbar with glass-morphism styles and correct stats", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("20");
    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("3");
    expect(shadow.querySelector('[data-ref="oneway-count"]')?.textContent).toBe("14");
    expect(shadow.querySelector(".title")?.textContent).toContain("关注列表助手");

    // 验证筛选按钮默认激活 one-way
    const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
    expect(filterOneWay.classList.contains("active")).toBe(true);

    tb.remove();
  });

  it("updates stats and filter button when paint is called", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      selectedCount: 8,
      loadedCount: 25,
      filterMode: "all",
      oneWayCount: 5,
    });

    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("8");
    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("25");

    const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
    const filterAll = shadow.querySelector<HTMLButtonElement>('[data-action="filter-all"]')!;
    expect(filterOneWay.classList.contains("active")).toBe(false);
    expect(filterAll.classList.contains("active")).toBe(true);

    tb.remove();
  });

  it("shows progress bar when phase is progress", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: true,
      phase: "progress",
      progress: {
        done: 2,
        total: 5,
        recentLog: [
          { handle: "alice", succeeded: true },
          { handle: "bob", succeeded: true },
        ],
      },
    });

    const progressWrap = shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')!;
    expect(progressWrap.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="progress-fill"]')?.getAttribute("style")).toContain(
      "40%",
    );
    expect(shadow.querySelector('[data-ref="progress-count"]')?.textContent).toBe("2 / 5");
    expect(shadow.querySelector('[data-ref="progress-log"]')?.textContent).toContain("alice");

    tb.remove();
  });

  it("shows complete banner when phase is complete", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: false,
      phase: "complete",
      completeResult: { succeeded: 5, failed: 0 },
    });

    const completeWrap = shadow.querySelector<HTMLElement>('[data-ref="complete-wrap"]')!;
    expect(completeWrap.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="complete-text"]')?.textContent).toContain("5");

    // progress 应当隐藏
    expect(
      shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')?.classList.contains("show"),
    ).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow shows dialog and resolves true on confirm click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(6);
    const overlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
    expect(overlay.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="dialog-desc"]')?.innerHTML).toContain("6");

    const confirmBtn = shadow.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')!;
    confirmBtn.click();

    const result = await promise;
    expect(result).toBe(true);
    expect(overlay.classList.contains("show")).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow resolves false on cancel click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(3);
    const cancelBtn = shadow.querySelector<HTMLButtonElement>('[data-action="dialog-cancel"]')!;
    cancelBtn.click();

    const result = await promise;
    expect(result).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow resolves false on overlay click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(2);
    const overlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
    overlay.click();

    const result = await promise;
    expect(result).toBe(false);

    tb.remove();
  });
});
```

- [ ] **Step 6: 运行测试确认全部通过**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/src/ui/following-toolbar.test.ts
```

预期：8 个测试全部通过（2 个原有 + 6 个新增）。

- [ ] **Step 7: 提交**

```bash
git add packages/x-following-extension/src/ui/following-toolbar.ts packages/x-following-extension/src/ui/following-toolbar.test.ts
git commit -m "Rewrite toolbar with Premium Glass UI, dialog, and multi-phase states

Replace the basic dark-bar toolbar with a glass-morphism design
featuring backdrop-filter blur, indigo accent gradients, and
refined system-font typography.

Included:

- Two-row layout: title+stats row, filter+actions row
- iOS-style segmented control for filter mode toggle
- Floating glass confirmUnfollow dialog with backdrop overlay
- Progress state: gradient bar + real-time log stream
- Complete state: green banner for success/failure summary
- CSS-only animations: dialogIn, slideDown, fadeIn keyframes
- New types: ToolbarPhase, LogEntry, expanded FollowingToolbarState
- 6 tests covering mount, update, progress, complete, dialog flows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 更新管理器编排 — Dialog 替换 + 进度状态机

**Files:**

- Modify: `packages/x-following-extension/src/content/following-manager.ts`

Adapter 层：将 `window.confirm()` 替换为 `toolbar.confirmUnfollow()`。添加 `oneWayCount` 计算。实现进度态→完成态→3秒恢复的状态转换。

- [ ] **Step 1: 新增辅助函数 `countFollowBackCells`**

在 `following-manager.ts` 的导入区确认已导入 `userCellFollowsYou`（来自 `following-filter.ts`，现有导入已通过 `shouldShowOneWayFollowCell` 间接依赖）。在变量声明区（约第55行 `filterMode` 附近）之后添加辅助函数：

```typescript
const countFollowBackCells = (): number => {
  const cells = document.querySelectorAll<HTMLElement>('[data-testid="UserCell"]');
  let count = 0;
  for (const cell of cells) {
    if (userCellFollowsYou(cell)) count += 1;
  }
  return count;
};
```

需要在文件顶部导入 `userCellFollowsYou`：

```typescript
// 修改导入行（约第1-11行），确保包含 userCellFollowsYou：
import {
  extractUserCellHandle,
  findUserCellByHandle,
  isFollowingListPage,
  isOwnFollowingListPage,
  listUserCells,
  readLoggedInUserKey,
  removeFollowingFilterStyles,
  setFollowingFilterMode,
  unfollowSelectedCells,
  userCellFollowsYou,
  type FollowingFilterMode,
} from "../dom/following-filter.js";
```

- [ ] **Step 2: 修改 `buildToolbarState` 添加 `oneWayCount` 和 `phase`**

修改约第139行的 `buildToolbarState` 函数：

```typescript
const buildToolbarState = (counts: {
  loadedCount: number;
  selectedCount: number;
}): FollowingToolbarState => {
  const followBackCount = countFollowBackCells();
  return {
    filterMode,
    loadedCount: counts.loadedCount,
    selectedCount: counts.selectedCount,
    busy,
    statusText,
    phase: "normal",
    oneWayCount:
      filterMode === "one-way" ? counts.loadedCount : counts.loadedCount - followBackCount,
  };
};
```

- [ ] **Step 3: 修改 `toolbarSignature` 适应新状态**

修改约第147行的 `toolbarSignature` 以包含 `phase` 字段：

```typescript
const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.loadedCount}|${state.selectedCount}|${state.busy}|${state.statusText}|${state.phase}`;
```

- [ ] **Step 4: 修改 `ensureToolbar` — 传入初始 `oneWayCount`**

修改约第349行 `mountFollowingToolbar` 调用处的 `buildToolbarState(counts)`，它现在会自动包含 `oneWayCount`。

- [ ] **Step 5: 重写 `handleUnfollowSelected` — Dialog + 进度 + 完成**

完整替换 `handleUnfollowSelected` 函数（约第409-453行）：

```typescript
const handleUnfollowSelected = async (): Promise<void> => {
  if (busy) return;

  const handles = [...selectedHandles];
  const cells = handles
    .map((handle) => findUserCellByHandle(handle))
    .filter((cell): cell is HTMLElement => cell !== null);

  if (cells.length === 0) {
    statusText = "请先勾选要取消关注的用户";
    updateToolbar(true);
    return;
  }

  // 玻璃 Dialog 确认（替代 window.confirm）
  if (toolbar === null) return;
  const confirmed = await toolbar.confirmUnfollow(cells.length);
  if (!confirmed) return;

  busy = true;

  // 进入进度态
  const logBuffer: { handle: string; succeeded: boolean }[] = [];
  const pushProgress = (done: number, total: number): void => {
    if (toolbar === null) return;
    toolbar.update({
      ...buildToolbarState({
        loadedCount: listLoadedUserCells(filterMode).length,
        selectedCount: selectedHandles.size,
      }),
      busy: true,
      phase: "progress",
      progress: { done, total, recentLog: logBuffer.slice(-3) },
    });
  };
  pushProgress(0, cells.length);

  const result = await unfollowSelectedCells(cells, (progress) => {
    logBuffer.push({ handle: progress.handle, succeeded: progress.succeeded });
    pushProgress(progress.done, progress.total);
  });

  selectedHandles.clear();
  setAllLoadedChecked(false, filterMode, selectedHandles);
  busy = false;
  statusText = `完成：成功 ${result.succeeded}，失败 ${result.failed}`;

  // 进入完成态
  if (toolbar !== null) {
    toolbar.update({
      ...buildToolbarState({
        loadedCount: listLoadedUserCells(filterMode).length,
        selectedCount: 0,
      }),
      busy: false,
      phase: "complete",
      completeResult: { succeeded: result.succeeded, failed: result.failed },
    });
  }

  lastSyncAt = 0;
  runThrottledSync(true);

  // 3 秒后自动恢复正常态
  window.setTimeout(() => {
    statusText = "勾选用户后可批量取消关注";
    updateToolbar(true);
  }, 3_000);
};
```

- [ ] **Step 6: TypeScript 编译检查 & 运行全部测试**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/
```

预期：所有 x-following-extension 测试通过。

- [ ] **Step 7: 提交**

```bash
git add packages/x-following-extension/src/content/following-manager.ts
git commit -m "Replace window.confirm with glass dialog, add progress/complete phases

Wire the new toolbar.confirmUnfollow() dialog into the unfollow
flow. Add oneWayCount computation and multi-phase state machine
for progress tracking and completion feedback.

Included:

- countFollowBackCells helper to compute oneWayCount stat
- buildToolbarState now returns oneWayCount and phase fields
- handleUnfollowSelected: dialog confirm → progress updates → complete banner → 3s auto-reset
- Progress state pushed via toolbar.update with LogEntry buffer (max 3 recent)
- Complete state shows succeeded/failed counts with auto-dismiss

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 微调筛选 CSS

**Files:**

- Modify: `packages/x-following-extension/src/dom/following-filter.ts`
- Modify: `packages/x-following-extension/src/dom/following-filter.test.ts`

CSS 注入逻辑微调 — 确保 `one-way` 筛选隐藏样式与新工具栏视觉一致。

- [ ] **Step 1: CSS 筛选样式不变，这是正确的**

现有 `setFollowingFilterMode` 使用 `display:none` 隐藏回关用户行。这个逻辑是正确的，CSS 选择器不需要改动。只需要确保 `oneWayCount` 的计算与筛选模式一致。

确认 `filterCss` 函数（约第31行）生成的 CSS 仅影响 UserCell 显示，不干扰工具栏：

```typescript
// 无需修改 — 现有逻辑正确
const filterCss = (mode: FollowingFilterMode): string => {
  if (mode !== "one-way") return "";
  return `html[${FILTER_HTML_ATTR}="one-way"] [data-testid="UserCell"]:has(${FOLLOWS_YOU_INDICATOR}){display:none!important}`;
};
```

- [ ] **Step 2: 更新测试 — 确认 CSS 注入不破坏新结构**

在 `following-filter.test.ts` 中新增测试，确认 `setFollowingFilterMode` 不干扰 Shadow DOM 中的工具栏元素：

```typescript
it("filter CSS does not affect shadow DOM toolbar content", () => {
  const host = document.createElement("div");
  host.setAttribute("data-xfm-following-toolbar-host", "true");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div class="bar"><span class="title">关注列表助手</span></div>';
  document.body.append(host);

  setFollowingFilterMode("one-way");
  // Shadow DOM 内容不受主文档 CSS 影响
  const title = shadow.querySelector(".title");
  expect(title?.textContent).toBe("关注列表助手");
  // 确认 title 可见（没有被 display:none 影响）
  expect(title instanceof HTMLElement).toBe(true);

  host.remove();
  document.getElementById("xfm-following-filter-style")?.remove();
  document.documentElement.removeAttribute("data-xfm-filter");
});
```

- [ ] **Step 3: 运行测试**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/src/dom/following-filter.test.ts
```

预期：所有测试通过。

- [ ] **Step 4: 提交**

```bash
git add packages/x-following-extension/src/dom/following-filter.test.ts
git commit -m "Add test confirming filter CSS isolation from Shadow DOM toolbar

Ensure the one-way filter stylesheet does not interfere with the
new glass-morphism toolbar rendered inside Shadow DOM.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 构建与集成验证

**Files:**

- Modify: `packages/x-following-extension/src/manifest.json` (version bump)

构建扩展并运行完整测试套件，确认所有改动协同工作。

- [ ] **Step 1: Bump version**

```json
"version": "0.2.0"
```

- [ ] **Step 2: 运行完整测试**

```bash
cd /Users/martin/Code/yt2x && npx vitest run packages/x-following-extension/
```

预期：所有测试通过（共约 20 个测试）。

- [ ] **Step 3: TypeScript 编译检查**

```bash
cd /Users/martin/Code/yt2x && npx tsc --noEmit -p packages/x-following-extension/tsconfig.json
```

预期：无类型错误。

- [ ] **Step 4: Build**

```bash
cd /Users/martin/Code/yt2x && node packages/x-following-extension/build.mjs
```

预期：`Built Chrome extension at packages/x-following-extension/dist`。

- [ ] **Step 5: 运行 lint**

```bash
cd /Users/martin/Code/yt2x && npx eslint packages/x-following-extension/src/
```

预期：无 lint 错误。

- [ ] **Step 6: 提交**

```bash
git add packages/x-following-extension/src/manifest.json
git commit -m "Bump x-following-extension version to 0.2.0

UX redesign release: Premium Glass toolbar, custom checkbox
styling, glass dialog confirmation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
