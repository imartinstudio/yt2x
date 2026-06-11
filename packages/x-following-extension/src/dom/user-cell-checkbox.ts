import { extractUserCellHandle, shouldShowCheckboxOnCell, type FollowingFilterMode } from "./following-filter.js";

export const CHECKBOX_INPUT_ATTR = "data-xfm-follow-select-input";
export const CHECKBOX_HIT_ATTR = "data-xfm-follow-select-hit";
export const CHECKBOX_PAD_ATTR = "data-xfm-follow-padded";
export const CHECKBOX_ROW_ATTR = "data-xfm-follow-row";
export const CHECKBOX_VISUAL_ATTR = "data-xfm-follow-select-visual";

const HIT_ZONE_WIDTH_PX = 52;
const CHECKBOX_RESERVE_STYLE_ID = "xfm-checkbox-reserve-style";
const CHECKBOX_THEME_STYLE_ID = "xfm-checkbox-theme-style";

/**
 * Per-input 同步标记 — 通过 dataset.xfmSyncing 区分程序化同步和用户点击，
 * 避免同步期间批量变更意外修改 selectedHandles 导致闪烁。
 */

/** 注入勾选框配色 CSS 变量，跟随系统深/浅模式。 */
export const injectCheckboxTheme = (): void => {
  if (document.getElementById(CHECKBOX_THEME_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CHECKBOX_THEME_STYLE_ID;
  style.textContent = [
    ":root {",
    "  --xfm-cb-border: rgba(255,255,255,0.12);",
    "  --xfm-cb-bg-checked: rgba(99,102,241,0.2);",
    "  --xfm-cb-border-checked: rgba(129,140,248,0.6);",
    "  --xfm-cb-glow: rgba(99,102,241,0.2);",
    "  --xfm-cb-check: white;",
    "}",
    "@media (prefers-color-scheme: light) {",
    "  :root {",
    "    --xfm-cb-border: rgba(0,0,0,0.18);",
    "    --xfm-cb-bg-checked: rgba(0,0,0,0.88);",
    "    --xfm-cb-border-checked: rgba(0,0,0,0.88);",
    "    --xfm-cb-glow: rgba(0,0,0,0.08);",
    "    --xfm-cb-check: white;",
    "  }",
    "}",
  ].join("\n");
  document.head.append(style);
};

/** 预先用 CSS 给 UserCell 父容器预留 checkbox 空间，避免异步插入 checkbox 时布局偏移。 */
export const reserveCheckboxSpace = (): void => {
  if (document.getElementById(CHECKBOX_RESERVE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CHECKBOX_RESERVE_STYLE_ID;
  style.textContent = `:has(> [data-testid="UserCell"]){padding-left:${HIT_ZONE_WIDTH_PX}px;position:relative}`;
  document.head.append(style);
};

export const removeCheckboxSpaceReservation = (): void => {
  document.getElementById(CHECKBOX_RESERVE_STYLE_ID)?.remove();
};

const createVisualSpan = (): HTMLSpanElement => {
  const span = document.createElement("span");
  span.setAttribute(CHECKBOX_VISUAL_ATTR, "true");
  span.style.cssText = [
    "width:20px",
    "height:20px",
    "border-radius:5px",
    "border:1.5px solid var(--xfm-cb-border)",
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
    span.style.background = "var(--xfm-cb-bg-checked)";
    span.style.borderColor = "var(--xfm-cb-border-checked)";
    span.style.boxShadow = "0 0 24px var(--xfm-cb-glow)";
    span.style.color = "var(--xfm-cb-check)";
    span.textContent = "✓";
  } else {
    span.style.background = "transparent";
    span.style.borderColor = "var(--xfm-cb-border)";
    span.style.boxShadow = "none";
    span.style.color = "transparent";
    span.textContent = "";
  }
};

/** 无动画更新 visual span：先更新状态再一次性提交，避免双 reflow 导致旧状态被绘制到屏幕。 */
const updateVisualSpanInstant = (span: HTMLSpanElement, checked: boolean): void => {
  span.style.transition = "none";
  void span.offsetHeight; // 强制提交 transition:none
  updateVisualSpan(span, checked);
  void span.offsetHeight; // 强制提交新样式（无过渡）
  span.style.transition = "all 0.15s cubic-bezier(0.34,1.56,0.64,1)";
};

const HIT_ZONE_HEIGHT_PX = 40;

const hitZoneStyle = [
  "position:absolute",
  "left:0",
  "top:0",
  `width:${HIT_ZONE_WIDTH_PX}px`,
  `height:${HIT_ZONE_HEIGHT_PX}px`,
  "margin:0",
  "display:flex",
  "align-items:center",
  "justify-content:center",
  "cursor:pointer",
  "z-index:2",
  "touch-action:manipulation",
  "-webkit-tap-highlight-color:transparent",
].join(";");

const inputStyle = [
  "position:absolute",
  "opacity:0",
  "width:1px",
  "height:1px",
  "margin:0",
  "pointer-events:none",
].join(";");

export type UserCellMount = {
  mountEl: HTMLElement;
  userCell: HTMLElement;
};

/** X 实页 UserCell 为 BUTTON：热区作为 button 的兄弟节点插入，避免被 React 清空 button 内部。 */
export const resolveUserCellMount = (cell: HTMLElement): UserCellMount => {
  if (cell.matches('[data-testid="UserCell"]') && cell.parentElement instanceof HTMLElement) {
    return { mountEl: cell.parentElement, userCell: cell };
  }
  return { mountEl: cell, userCell: cell };
};

const findHitZone = (mount: UserCellMount): HTMLElement | null => {
  const { mountEl, userCell } = mount;
  const prev = userCell.previousElementSibling;
  if (prev instanceof HTMLElement && prev.matches(`[${CHECKBOX_HIT_ATTR}]`)) return prev;
  return mountEl.querySelector<HTMLElement>(`:scope > [${CHECKBOX_HIT_ATTR}]`);
};

const normalizeHandle = (handle: string | null): string | null =>
  handle === null ? null : handle.toLowerCase();

const findCheckboxInput = (mount: UserCellMount, handle: string | null): HTMLInputElement | null => {
  const hit = findHitZone(mount);
  if (hit === null) return null;
  const input = hit.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
  if (input === null) return null;
  const normalized = normalizeHandle(handle);
  if (normalized === null || input.dataset.xfmHandle === normalized) return input;
  return null;
};

const findUserCellForHit = (hit: HTMLElement): HTMLElement | null => {
  const next = hit.nextElementSibling;
  if (next instanceof HTMLElement && next.matches('[data-testid="UserCell"]')) return next;
  return hit.parentElement?.querySelector<HTMLElement>('[data-testid="UserCell"]') ?? null;
};

const syncInputHandleFromCurrentCell = (hit: HTMLElement, input: HTMLInputElement): void => {
  const domCell = findUserCellForHit(hit);
  if (domCell === null) return;
  const currentHandle = extractUserCellHandle(domCell);
  if (currentHandle !== null) input.dataset.xfmHandle = currentHandle;
};

const toggleInputFromHitZone = (hit: HTMLElement, input: HTMLInputElement): void => {
  syncInputHandleFromCurrentCell(hit, input);
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const stopHitZoneEvent = (event: Event): void => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

const bindHitZoneInteraction = (hit: HTMLElement, input: HTMLInputElement): void => {
  if (hit.dataset.xfmHitBound === "true") return;
  hit.dataset.xfmHitBound = "true";
  hit.tabIndex = 0;
  hit.setAttribute("role", "checkbox");

  hit.addEventListener(
    "pointerdown",
    (event) => {
      stopHitZoneEvent(event);
    },
    { capture: true },
  );

  hit.addEventListener(
    "pointerup",
    (event) => {
      stopHitZoneEvent(event);
      hit.dataset.xfmLastPointerToggleAt = String(Date.now());
      toggleInputFromHitZone(hit, input);
    },
    { capture: true },
  );

  hit.addEventListener(
    "click",
    (event) => {
      stopHitZoneEvent(event);
      const lastPointerToggleAt = Number(hit.dataset.xfmLastPointerToggleAt ?? 0);
      if (Date.now() - lastPointerToggleAt < 500) return;
      toggleInputFromHitZone(hit, input);
    },
    { capture: true },
  );

  hit.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    stopHitZoneEvent(event);
    toggleInputFromHitZone(hit, input);
  });
};

/** 复用行上已有热区并更正 handle，避免虚拟列表复用 DOM 时拆掉勾选框导致闪烁。 */
export const findOrReuseCheckboxInput = (
  mount: UserCellMount,
  handle: string | null,
): HTMLInputElement | null => {
  const normalized = normalizeHandle(handle);
  const matched = findCheckboxInput(mount, normalized);
  if (matched !== null) return matched;

  const hit = findHitZone(mount);
  if (hit === null) return null;
  const input = hit.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
  if (input === null) return null;
  if (normalized !== null) input.dataset.xfmHandle = normalized;
  return input;
};

export const ensureUserCellCheckbox = (cell: HTMLElement): HTMLInputElement => {
  const mount = resolveUserCellMount(cell);
  const handle = normalizeHandle(extractUserCellHandle(mount.userCell));

  const existingInput = findOrReuseCheckboxInput(mount, handle);
  if (existingInput !== null) {
    const existingHit = existingInput.closest<HTMLElement>(`[${CHECKBOX_HIT_ATTR}]`);
    if (existingHit !== null) bindHitZoneInteraction(existingHit, existingInput);
    return existingInput;
  }

  findHitZone(mount)?.remove();

  if (mount.mountEl.getAttribute(CHECKBOX_PAD_ATTR) !== "true") {
    const computed = window.getComputedStyle(mount.mountEl);
    const currentPad = Number.parseFloat(computed.paddingLeft) || 0;
    // CSS reserveCheckboxSpace 已为大部分 wrapper 预留 52px。
    // 仅在 CSS 未覆盖时由 JS 补足，避免双重叠加导致错位。
    if (currentPad < HIT_ZONE_WIDTH_PX - 1) {
      mount.mountEl.style.paddingLeft = `${HIT_ZONE_WIDTH_PX}px`;
    }
    if (computed.position === "static") mount.mountEl.style.position = "relative";
    mount.mountEl.setAttribute(CHECKBOX_PAD_ATTR, "true");
    mount.mountEl.setAttribute(CHECKBOX_ROW_ATTR, "true");
  }

  // 读取 X UserCell 内部 padding 以动态对齐头像中心
  const cellStyle = window.getComputedStyle(mount.userCell);
  const cellPadTop = Number.parseFloat(cellStyle.paddingTop) || 0;

  const hit = document.createElement("label");
  hit.setAttribute(CHECKBOX_HIT_ATTR, "true");
  hit.setAttribute("aria-label", "选择此用户");
  hit.style.cssText = hitZoneStyle;
  hit.style.top = `${cellPadTop}px`;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute(CHECKBOX_INPUT_ATTR, "true");
  if (handle !== null) input.dataset.xfmHandle = handle;
  input.style.cssText = inputStyle;

  hit.append(input);

  const visual = createVisualSpan();
  updateVisualSpan(visual, input.checked);
  hit.append(visual);
  hit.setAttribute("aria-checked", String(input.checked));

  bindHitZoneInteraction(hit, input);

  input.addEventListener("change", () => {
    const vis = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (vis) updateVisualSpan(vis, input.checked);
    hit.setAttribute("aria-checked", String(input.checked));
  });

  mount.mountEl.insertBefore(hit, mount.userCell);
  return input;
};

export const removeUserCellCheckboxes = (root: ParentNode = document): void => {
  for (const hit of root.querySelectorAll<HTMLElement>(`[${CHECKBOX_HIT_ATTR}]`)) {
    hit.remove();
  }
  for (const row of root.querySelectorAll<HTMLElement>(`[${CHECKBOX_ROW_ATTR}]`)) {
    if (row.getAttribute(CHECKBOX_PAD_ATTR) === "true") {
      row.style.removeProperty("padding-left");
      row.style.removeProperty("position");
      row.removeAttribute(CHECKBOX_PAD_ATTR);
      row.removeAttribute(CHECKBOX_ROW_ATTR);
    }
  }
};

export const removeUserCellCheckbox = (cell: HTMLElement): void => {
  const mount = resolveUserCellMount(cell);
  findHitZone(mount)?.remove();
  if (mount.mountEl.getAttribute(CHECKBOX_PAD_ATTR) !== "true") return;
  mount.mountEl.style.removeProperty("padding-left");
  mount.mountEl.style.removeProperty("position");
  mount.mountEl.removeAttribute(CHECKBOX_PAD_ATTR);
  mount.mountEl.removeAttribute(CHECKBOX_ROW_ATTR);
};

export const removeFilteredOutCheckboxes = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
): void => {
  if (mode === "all") return;
  const scope = listScope(root);
  for (const cell of scope.querySelectorAll<HTMLElement>('[data-testid="UserCell"]')) {
    if (shouldShowCheckboxOnCell(cell, mode)) continue;
    removeUserCellCheckbox(cell);
  }
};

export const cleanupCheckboxArtifacts = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
): void => {
  const scope = listScope(root);
  for (const hit of scope.querySelectorAll<HTMLElement>(`[${CHECKBOX_HIT_ATTR}]`)) {
    const cell = hit.nextElementSibling;
    if (!(cell instanceof HTMLElement) || !cell.matches('[data-testid="UserCell"]')) {
      hit.remove();
      continue;
    }
    if (!shouldShowCheckboxOnCell(cell, mode)) removeUserCellCheckbox(cell);
  }
};

export const cellHasCheckbox = (cell: HTMLElement): boolean => {
  const mount = resolveUserCellMount(cell);
  return findCheckboxInput(mount, extractUserCellHandle(mount.userCell)) !== null;
};

export const cellNeedsCheckboxAttach = (cell: HTMLElement): boolean => {
  const mount = resolveUserCellMount(cell);
  const handle = extractUserCellHandle(mount.userCell);
  return findCheckboxInput(mount, handle) === null;
};

export const isUserCellInViewport = (cell: HTMLElement): boolean => {
  const { userCell } = resolveUserCellMount(cell);
  if (!userCell.isConnected) return false;
  const rect = userCell.getBoundingClientRect();
  if (rect.height < 8 || rect.width < 8) return false;
  return rect.bottom > 0 && rect.top < window.innerHeight;
};

const listScope = (root: ParentNode): ParentNode =>
  root.querySelector('[data-testid="primaryColumn"]') ?? root;

/** 主栏时间线里已挂载到 DOM 的账号行（含滚出视口、尚未注入勾选框的行）。 */
export const listLoadedUserCells = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
): HTMLElement[] => {
  const scope = listScope(root);
  return [...scope.querySelectorAll<HTMLElement>('[data-testid="UserCell"]')].filter((cell) =>
    shouldShowCheckboxOnCell(cell, mode),
  );
};

export const listViewportUserCells = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
): HTMLElement[] =>
  listLoadedUserCells(mode, root).filter((cell) => isUserCellInViewport(cell));

/** 视口内已勾选的 handle（仅 DOM 扫描；批量操作应以 selectedHandles Set 为准）。 */
export const getCheckedHandlesInViewport = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
): string[] => {
  const handles: string[] = [];
  for (const cell of listViewportUserCells(mode, root)) {
    const mount = resolveUserCellMount(cell);
    const handle = extractUserCellHandle(mount.userCell);
    const input = findCheckboxInput(mount, handle);
    if (input?.checked !== true) continue;
    if (handle !== null) handles.push(handle);
  }
  return handles;
};

/** @deprecated 使用 getCheckedHandlesInViewport 或传入的 selectedHandles Set */
export const getSelectedHandles = getCheckedHandlesInViewport;

export const applyCheckboxChangeToSelection = (
  input: HTMLInputElement,
  selectedHandles: Set<string>,
): void => {
  const handle = input.dataset.xfmHandle?.toLowerCase() ?? null;
  if (handle === null || handle.length === 0) return;

  // 从 DOM 验证 handle 是否与当前 cell 内容一致（防止虚拟列表回收导致串号）
  const hit = input.closest(`[${CHECKBOX_HIT_ATTR}]`);
  if (hit instanceof HTMLElement) {
    const cell = findUserCellForHit(hit);
    if (cell instanceof HTMLElement) {
      const domHandle = extractUserCellHandle(cell);
      if (domHandle !== null && domHandle !== handle) return;
    }
  }

  // Per-input 标记：程序化同步时跳过 selectedHandles 修改，但用户点击不受影响
  if (input.dataset.xfmSyncing === "true") return;

  if (input.checked) selectedHandles.add(handle);
  else selectedHandles.delete(handle);
};

const setCellsChecked = (
  cells: HTMLElement[],
  checked: boolean,
  selectedHandles?: Set<string>,
): void => {
  for (const cell of cells) {
    const mount = resolveUserCellMount(cell);
    const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
    const input = findOrReuseCheckboxInput(mount, handle) ?? ensureUserCellCheckbox(cell);
    if (input.checked !== checked) {
      input.dataset.xfmSyncing = "true";
      input.checked = checked;
      delete input.dataset.xfmSyncing;
    }
    // 同步视觉 span
    const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (visual) updateVisualSpan(visual, input.checked);
    if (selectedHandles === undefined || handle === null) continue;
    if (checked) selectedHandles.add(handle);
    else selectedHandles.delete(handle);
  }
};

export const clearExistingLoadedChecked = (
  mode: FollowingFilterMode,
  selectedHandles?: Set<string>,
  root: ParentNode = document,
): void => {
  for (const cell of listLoadedUserCells(mode, root)) {
    const mount = resolveUserCellMount(cell);
    const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
    const input = findOrReuseCheckboxInput(mount, handle);
    if (input === null) continue;
    if (input.checked) {
      input.dataset.xfmSyncing = "true";
      input.checked = false;
      delete input.dataset.xfmSyncing;
    }
    const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (visual) updateVisualSpanInstant(visual, false);
    if (selectedHandles !== undefined && handle !== null) selectedHandles.delete(handle);
  }
};

export const setAllLoadedChecked = (
  checked: boolean,
  mode: FollowingFilterMode,
  selectedHandles?: Set<string>,
  root: ParentNode = document,
): void => {
  setCellsChecked(listLoadedUserCells(mode, root), checked, selectedHandles);
};

export const setAllVisibleChecked = (
  checked: boolean,
  mode: FollowingFilterMode,
  selectedHandles?: Set<string>,
  root: ParentNode = document,
): void => {
  setCellsChecked(listViewportUserCells(mode, root), checked, selectedHandles);
};

export const applySelectionToViewportCells = (
  selectedHandles: ReadonlySet<string>,
  mode: FollowingFilterMode,
  root: ParentNode = document,
): void => {
  for (const cell of listViewportUserCells(mode, root)) {
    if (!shouldShowCheckboxOnCell(cell, mode)) continue;
    const mount = resolveUserCellMount(cell);
    const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
    if (handle === null) continue;
    const input = findOrReuseCheckboxInput(mount, handle);
    if (input === null) continue;
    const shouldCheck = selectedHandles.has(handle);
    if (input.checked !== shouldCheck) {
      input.dataset.xfmSyncing = "true";
      input.checked = shouldCheck;
      delete input.dataset.xfmSyncing;
      const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
      if (visual) updateVisualSpanInstant(visual, input.checked);
    }
  }
};

export const syncCheckboxOnCell = (
  cell: HTMLElement,
  selectedHandles: ReadonlySet<string>,
  mode: FollowingFilterMode,
): void => {
  if (!shouldShowCheckboxOnCell(cell, mode)) {
    removeUserCellCheckbox(cell);
    return;
  }
  const mount = resolveUserCellMount(cell);
  const handle = normalizeHandle(extractUserCellHandle(mount.userCell));
  if (handle === null) return;
  const shouldCheck = selectedHandles.has(handle);
  const input = findOrReuseCheckboxInput(mount, handle) ?? ensureUserCellCheckbox(cell);
  if (input.dataset.xfmHandle !== handle) input.dataset.xfmHandle = handle;
  if (input.checked !== shouldCheck) {
    input.dataset.xfmSyncing = "true";
    input.checked = shouldCheck;
    delete input.dataset.xfmSyncing;
    const visual = input.parentElement?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    if (visual) updateVisualSpanInstant(visual, input.checked);
  }
};
