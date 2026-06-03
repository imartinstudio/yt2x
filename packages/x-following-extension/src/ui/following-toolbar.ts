import type { FollowingFilterMode } from "../dom/following-filter.js";

export type FollowingToolbarState = {
  filterMode: FollowingFilterMode;
  loadedCount: number;
  selectedCount: number;
  busy: boolean;
  statusText: string;
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
 * 插入锚点：sticky tab 顶栏之后；若紧邻极薄分割条则再往后挪到横线下方。
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
  host.style.background = "rgb(0, 0, 0)";
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

const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.loadedCount}|${state.selectedCount}|${state.busy}|${state.statusText}`;

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
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .bar {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid rgb(47, 51, 54);
        background: rgb(0, 0, 0);
        color: rgb(231, 233, 234);
      }
      .title { font-size: 15px; font-weight: 700; }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 12px 16px;
        align-items: center;
      }
      .filters label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        cursor: pointer;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      button {
        border: 1px solid rgb(83, 100, 113);
        border-radius: 9999px;
        background: transparent;
        color: rgb(231, 233, 234);
        font-size: 13px;
        font-weight: 600;
        padding: 6px 14px;
        cursor: pointer;
      }
      button:disabled { opacity: 0.45; cursor: not-allowed; }
      button.primary { border-color: rgb(244, 33, 46); color: rgb(244, 33, 46); }
      button.primary:not(:disabled):hover { background: rgba(244, 33, 46, 0.12); }
      .meta { font-size: 13px; color: rgb(113, 118, 123); }
      .status { font-size: 13px; color: rgb(113, 118, 123); min-height: 18px; }
    </style>
    <div class="bar">
      <div class="title">关注列表助手</div>
      <div class="filters">
        <span>筛选：</span>
        <label><input type="radio" name="xfm-filter" value="one-way" /> 仅未回关</label>
        <label><input type="radio" name="xfm-filter" value="all" /> 全部</label>
        <span class="meta" data-ref="meta"></span>
      </div>
      <div class="actions">
        <button type="button" data-action="select-all">全选列表</button>
        <button type="button" data-action="clear-selection">取消勾选</button>
        <button type="button" class="primary" data-action="unfollow-selected">取消关注所选</button>
      </div>
      <div class="status" data-ref="status"></div>
    </div>
  `;

  const filterInputs = shadow.querySelectorAll<HTMLInputElement>('input[name="xfm-filter"]');
  const metaEl = shadow.querySelector("[data-ref='meta']");
  const statusEl = shadow.querySelector("[data-ref='status']");
  const actionButtons = shadow.querySelectorAll<HTMLButtonElement>("[data-action]");

  filterInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked || input.disabled) return;
      handlers.onFilterModeChange(input.value === "all" ? "all" : "one-way");
    });
  });
  shadow.querySelector("[data-action='select-all']")?.addEventListener("click", () => handlers.onSelectAll());
  shadow.querySelector("[data-action='clear-selection']")?.addEventListener("click", () => handlers.onClearSelection());
  shadow.querySelector("[data-action='unfollow-selected']")?.addEventListener("click", () => handlers.onUnfollowSelected());

  let lastSignature = "";

  const paint = (state: FollowingToolbarState): void => {
    const signature = toolbarSignature(state);
    if (signature === lastSignature) return;
    lastSignature = signature;
    filterInputs.forEach((input) => {
      input.checked = input.value === state.filterMode;
      input.disabled = state.busy;
    });
    actionButtons.forEach((button) => {
      button.disabled = state.busy;
    });
    if (metaEl !== null) {
      metaEl.textContent = `当前列表 ${state.loadedCount} 人 · 已选 ${state.selectedCount} 人`;
    }
    if (statusEl !== null) statusEl.textContent = state.statusText;
  };

  paint(initialState);

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
    remove: () => {
      host.remove();
    },
  };
};
