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
  confirmUnfollow: (loadedCount: number, totalSelected: number) => Promise<boolean>;
  remove: () => void;
};

export type FollowingListInsertPoint = {
  /** 菜单插在此节点之后（tab 横线下方、用户列表 section 上方）。 */
  after: HTMLElement;
};

export const TOOLBAR_HOST_ATTR = "data-xfm-following-toolbar-host";

export const listFollowingToolbarHosts = (root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`)];

export const removeAllFollowingToolbarHosts = (root: ParentNode = document): void => {
  for (const host of listFollowingToolbarHosts(root)) {
    host.remove();
  }
};

const FOLLOWING_TAB_HREF = /\/following\/?$/u;
const FOLLOWING_TAB_LABEL = /^(正在关注|Following)$/u;
const TABLIST_SELECTORS = [
  '[data-testid="ScrollSnap-List"][role="tablist"]',
  '[role="tablist"]',
] as const;

export const findPrimaryColumn = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="primaryColumn"]');

const isFollowingTabAnchor = (anchor: HTMLAnchorElement): boolean =>
  FOLLOWING_TAB_HREF.test(anchor.pathname) ||
  FOLLOWING_TAB_LABEL.test(anchor.textContent?.trim() ?? "");

/** 主栏内「认证关注者 / 关注者 / 正在关注」tab 行（X 上为 ScrollSnap-List）。 */
export const findFollowingTablist = (): HTMLElement | null => {
  const column = findPrimaryColumn();
  if (column === null) return null;

  for (const selector of TABLIST_SELECTORS) {
    const tablist = column.querySelector<HTMLElement>(selector);
    if (tablist !== null) return tablist;
  }

  const tabAnchors = [...column.querySelectorAll<HTMLAnchorElement>("a[role='tab'], a[href]")];
  const followingTab =
    tabAnchors.find(
      (anchor) => anchor.getAttribute("aria-selected") === "true" && isFollowingTabAnchor(anchor),
    ) ?? tabAnchors.find((anchor) => isFollowingTabAnchor(anchor));
  if (followingTab === undefined) return null;

  return (
    followingTab.closest<HTMLElement>('[role="tablist"]') ??
    followingTab.parentElement ??
    followingTab
  );
};

/** 包裹 tab 的 sticky 顶栏（实页约 107px，含 tab 与底部分割）。 */
export const findTabStickyStrip = (tablist: HTMLElement): HTMLElement => {
  const column = findPrimaryColumn();
  let node: HTMLElement | null = tablist;
  let stickyStrip: HTMLElement = tablist;

  for (let depth = 0; depth < 12 && node !== null; depth += 1) {
    const style = window.getComputedStyle(node);
    if (style.position === "sticky" || style.position === "-webkit-sticky") {
      stickyStrip = node;
    }
    if (column !== null && node.parentElement === column) break;
    node = node.parentElement;
  }

  return stickyStrip;
};

/**
 * 插入锚点：sticky tab 顶栏之后；若紧邻极薄分割条则再往后挪到横线下方！
 * 实页结构：sticky(header+tabs) → 0px分割 div → section(UserCell…)
 */
export const findFollowingInsertAnchor = (tablist: HTMLElement): HTMLElement => {
  const strip = findTabStickyStrip(tablist);
  const next = strip.nextElementSibling;
  if (!(next instanceof HTMLElement)) return strip;

  const hasList =
    next.matches('[data-testid="UserCell"]') ||
    next.querySelector('[data-testid="UserCell"]') !== null ||
    next.matches("section[role='region'], section");
  if (hasList) return strip;

  const height = next.getBoundingClientRect().height;
  if (height <= 8) return next;

  return strip;
};

/** 吸顶 top = sticky tab 顶栏的 top + 高度，滚动时贴在 tab 横线正下方。 */
export const resolveToolbarStickyTopPx = (
  tablist: HTMLElement | null = findFollowingTablist(),
): number => {
  if (tablist === null) return 0;
  const strip = findTabStickyStrip(tablist);
  const style = window.getComputedStyle(strip);
  const isSticky =
    style.position === "sticky" || style.position === "-webkit-sticky";
  const stickyTop = isSticky ? Number.parseFloat(style.top) || 0 : 0;
  return stickyTop + strip.offsetHeight;
};

export const applyToolbarStickyLayout = (host: HTMLElement): void => {
  host.style.position = "sticky";
  host.style.zIndex = "3";
  host.style.top = `${resolveToolbarStickyTopPx()}px`;
  host.style.background = "var(--sticky-bg)";
  host.style.boxSizing = "border-box";
};

/** 插在 tab 横线下方、关注列表 section 上方。 */
export const findFollowingListInsertPoint = (): FollowingListInsertPoint | null => {
  const column = findPrimaryColumn();

  const tablist = findFollowingTablist();
  if (tablist !== null) {
    return { after: findFollowingInsertAnchor(tablist) };
  }

  const listSection =
    column?.querySelector<HTMLElement>('section[role="region"]') ??
    column?.querySelector<HTMLElement>("section");
  if (listSection?.previousElementSibling instanceof HTMLElement) {
    return { after: listSection.previousElementSibling };
  }

  const firstCell =
    column?.querySelector<HTMLElement>('[data-testid="UserCell"]') ??
    document.querySelector<HTMLElement>('[data-testid="UserCell"]');
  if (firstCell !== null) {
    const section = firstCell.closest("section");
    if (section?.previousElementSibling instanceof HTMLElement) {
      return { after: section.previousElementSibling };
    }
    const previous = firstCell.parentElement?.previousElementSibling;
    if (previous instanceof HTMLElement) return { after: previous };
  }

  return null;
};

export const findFollowingToolbarFallbackAnchor = (): HTMLElement | null =>
  findPrimaryColumn() ?? document.querySelector<HTMLElement>('main[role="main"]');

export const isToolbarMountedAtListTop = (
  host: HTMLElement,
  insertPoint: FollowingListInsertPoint | null,
): boolean => {
  if (insertPoint === null) return false;
  if (!host.isConnected) return false;
  return host.previousElementSibling === insertPoint.after;
};

export const mountFollowingToolbar = (
  insertPoint: FollowingListInsertPoint | null,
  fallbackAnchor: HTMLElement | null,
  handlers: FollowingToolbarHandlers,
  initialState: FollowingToolbarState,
): FollowingToolbar => {
  removeAllFollowingToolbarHosts();
  const host = document.createElement("div");
  host.setAttribute(TOOLBAR_HOST_ATTR, "true");
  applyToolbarStickyLayout(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
  <style>
    :host {
      all: initial;
      display: block;
      font-family: -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      color-scheme: light dark;
      /* dark */
      --bg-base: #0a0a14;
      --bg-surface: rgba(18,18,32,0.7);
      --glass-border: rgba(255,255,255,0.06);
      --text-pri: rgba(255,255,255,0.9);
      --text-sec: rgba(255,255,255,0.5);
      --text-dim: rgba(255,255,255,0.3);
      --accent: #818cf8;
      --accent-glow: rgba(99,102,241,0.2);
      --danger: #ef4444;
      --danger-glow: rgba(239,68,68,0.3);
      --success: #10b981;
      --btn-bg: rgba(255,255,255,0.05);
      --btn-border: rgba(255,255,255,0.06);
      --seg-bg: rgba(255,255,255,0.04);
      --seg-active: rgba(129,140,248,0.22);
      --sticky-bg: rgb(0, 0, 0);
      --bar-glow: rgba(99,102,241,0.08);
      --badge-bg: rgba(255,255,255,0.05);
      --btn-hover: rgba(255,255,255,0.08);
      --progress-track-bg: rgba(255,255,255,0.06);
      --complete-bg: rgba(10,25,15,0.6);
      --complete-border: rgba(16,185,129,0.5);
      --dialog-overlay-bg: rgba(0,0,0,0.6);
      --dialog-panel-bg: rgba(24,24,44,0.88);
      --dialog-panel-border: rgba(255,255,255,0.08);
      --dialog-panel-shadow: 0 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04) inset;
      --dialog-icon-bg: rgba(239,68,68,0.12);
      --btn-cancel-bg: rgba(255,255,255,0.05);
      --btn-cancel-border: rgba(255,255,255,0.06);
      --btn-danger-border: rgba(239,68,68,0.2);
      --btn-danger-bg: linear-gradient(135deg, rgba(239,68,68,0.65), rgba(220,38,38,0.55));
      --btn-danger-hover-shadow: 0 6px 24px rgba(239,68,68,0.45);
      --progress-fill-bg: linear-gradient(90deg, rgba(239,68,68,0.4), rgba(239,68,68,0.8), rgba(248,113,113,0.9));
      --progress-dot-bg: rgb(248,113,113);
      --progress-dot-shadow: 0 0 8px rgba(248,113,113,0.6);
    }
    @media (prefers-color-scheme: light) {
      :host {
        --bg-base: #f2f2f7;
        --bg-surface: rgba(255,255,255,0.82);
        --glass-border: rgba(0,0,0,0.08);
        --text-pri: rgba(0,0,0,0.88);
        --text-sec: rgba(0,0,0,0.55);
        --text-dim: rgba(0,0,0,0.35);
        --accent: #1a1a2e;
        --accent-glow: rgba(0,0,0,0.08);
        --danger: #dc2626;
        --danger-glow: rgba(220,38,38,0.22);
        --success: #059669;
        --btn-bg: rgba(0,0,0,0.05);
        --btn-border: rgba(0,0,0,0.08);
        --seg-bg: rgba(0,0,0,0.05);
        --seg-active: rgba(0,0,0,0.88);
        --sticky-bg: rgb(242, 242, 247);
        --bar-glow: rgba(0,0,0,0.03);
        --badge-bg: rgba(0,0,0,0.06);
        --btn-hover: rgba(0,0,0,0.08);
        --progress-track-bg: rgba(0,0,0,0.08);
        --complete-bg: rgba(16,185,129,0.1);
        --complete-border: rgba(5,150,105,0.45);
        --dialog-overlay-bg: rgba(0,0,0,0.35);
        --dialog-panel-bg: rgba(255,255,255,0.94);
        --dialog-panel-border: rgba(0,0,0,0.08);
        --dialog-panel-shadow: 0 40px 80px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05) inset;
        --dialog-icon-bg: rgba(220,38,38,0.1);
        --btn-cancel-bg: rgba(0,0,0,0.05);
        --btn-cancel-border: rgba(0,0,0,0.08);
        --btn-danger-border: rgba(220,38,38,0.32);
        --btn-danger-bg: linear-gradient(135deg, #f43f3f, #e01d1d);
        --btn-danger-hover-shadow: 0 8px 32px rgba(239,68,68,0.55);
        --progress-fill-bg: linear-gradient(90deg, rgba(239,68,68,0.55), rgba(239,68,68,0.88), rgba(248,113,113,0.95));
        --progress-dot-bg: rgb(239,68,68);
        --progress-dot-shadow: 0 0 8px rgba(239,68,68,0.45);
      }
    }
    .bar {
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
      background: radial-gradient(circle, var(--bar-glow), transparent 70%);
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
      background: var(--badge-bg);
      padding: 2px 7px;
      border-radius: 100px;
    }
    .stats {
      display: flex;
      gap: 14px;
      font-size: 11px;
      flex-shrink: 0;
    }
    .stat {
      color: var(--text-sec);
      white-space: nowrap;
    }
    .stat b { font-weight: 600; }
    .stat b.accent { color: var(--accent); }
    .stat b.danger { color: var(--danger); }
    .stat b.base { color: var(--text-pri); }

    .action-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: nowrap;
      overflow: hidden;
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
    .btn:hover { background: var(--btn-hover); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .btn-danger {
      border: 1px solid var(--btn-danger-border);
      background: var(--btn-danger-bg);
      color: white;
      font-weight: 600;
      box-shadow: 0 4px 16px var(--danger-glow);
    }
    .btn-danger:hover:not(:disabled) {
      background: var(--btn-danger-bg);
    }

    .tip-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      min-height: 16px;
    }
    .tip-warn {
      color: var(--danger);
      flex-shrink: 1;
    }
    .tip-status {
      color: var(--text-dim);
      flex-shrink: 0;
      text-align: right;
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
      background: var(--progress-track-bg);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: var(--progress-fill-bg);
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
      background: var(--progress-dot-bg);
      box-shadow: var(--progress-dot-shadow);
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
      background: var(--complete-bg);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-left: 3px solid var(--complete-border);
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
      background: var(--dialog-overlay-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
    }
    .dialog-overlay.show { display: flex; }

    .dialog-panel {
      background: var(--dialog-panel-bg);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border: 1px solid var(--dialog-panel-border);
      border-radius: 20px;
      padding: 24px;
      width: 360px;
      max-width: 90vw;
      box-shadow: var(--dialog-panel-shadow);
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
      background: var(--dialog-icon-bg);
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
      background: var(--btn-cancel-bg);
      border: 1px solid var(--btn-cancel-border);
      color: var(--text-sec);
      font-weight: 500;
    }
    .dialog-actions .btn-confirm {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      border: none;
      color: white;
      font-weight: 600;
    }

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
        X 清道夫
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

    <div class="tip-row">
	      <span class="tip-status" data-ref="status-text"></span>
	      <div class="spacer"></div>
	      <span class="tip-warn">⚠️ 建议分批取关，每小时不超过 50 人，以减少账号限制风险！</span>
	    </div>

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
  const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
  const filterAll = shadow.querySelector<HTMLButtonElement>('[data-action="filter-all"]')!;
  const unfollowBtn = shadow.querySelector<HTMLButtonElement>('[data-action="unfollow-selected"]')!;

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

  const confirmUnfollow = (_loadedCount: number, totalSelected: number): Promise<boolean> =>
    new Promise((resolve) => {
      dialogDesc.innerHTML = `将取消关注 <b>${totalSelected}</b> 个账号`;
      dialogResolve = resolve;
      dialogOverlay.classList.add("show");
    });

  // === Paint ===
  let lastSignature = "";

  const stateSignature = (s: FollowingToolbarState): string =>
    `${s.filterMode}|${s.loadedCount}|${s.selectedCount}|${s.busy}|${s.phase}|${s.oneWayCount}|${s.progress?.done ?? 0}|${s.progress?.total ?? 0}|${s.completeResult?.succeeded ?? 0}|${s.completeResult?.failed ?? 0}`;

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

  // === DOM 挂载（保持现有逻辑） ===
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
      dialogOverlay.classList.remove("show");
      dialogResolve?.(false);
      dialogResolve = null;
      host.remove();
    },
  };
};
