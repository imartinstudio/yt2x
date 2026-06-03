export const USER_CELL_SELECTOR = '[data-testid="UserCell"]';
const FOLLOWS_YOU_INDICATOR = '[data-testid="userFollowIndicator"]';
const UNFOLLOW_BUTTON_SELECTOR = '[data-testid$="-unfollow"]';
const CONFIRM_UNFOLLOW_SELECTOR = '[data-testid="confirmationSheetConfirm"]';
const FILTER_STYLE_ID = "xfm-following-filter-style";

export const FILTER_ATTR = "data-xfm-follow-filter";
export const CHECKBOX_WRAP_ATTR = "data-xfm-follow-select-wrap";
export const CHECKBOX_INPUT_ATTR = "data-xfm-follow-select-input";

const FOLLOWS_YOU_LABELS = /^(Follows you|关注了你)$/u;

const RESERVED_HANDLES = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "compose",
  "search",
  "settings",
  "i",
]);

export type FollowingFilterMode = "all" | "one-way";

export const isFollowingListPage = (pathname: string): boolean =>
  /\/following\/?$/u.test(pathname);

export const followingListUsername = (pathname: string): string | null => {
  const match = pathname.match(/^\/([^/]+)\/following\/?$/u);
  return match?.[1]?.toLowerCase() ?? null;
};

export const isOwnFollowingListPage = (
  pathname: string,
  loggedInUsername: string | null,
): boolean => {
  if (!isFollowingListPage(pathname)) return false;
  const pageUser = followingListUsername(pathname);
  if (pageUser === null || loggedInUsername === null) return false;
  return pageUser === loggedInUsername.toLowerCase();
};

export const ensureFollowingFilterStyles = (): void => {
  if (document.getElementById(FILTER_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = FILTER_STYLE_ID;
  style.textContent = `[data-testid="UserCell"][${FILTER_ATTR}="hidden"]{display:none!important}`;
  document.head.append(style);
};

export const removeFollowingFilterStyles = (): void => {
  document.getElementById(FILTER_STYLE_ID)?.remove();
};

export const userCellFollowsYou = (cell: Element): boolean => {
  if (cell.querySelector(FOLLOWS_YOU_INDICATOR) !== null) return true;
  return [...cell.querySelectorAll("span")].some((el) =>
    FOLLOWS_YOU_LABELS.test(el.textContent?.trim() ?? ""),
  );
};

export const shouldShowOneWayFollowCell = (cell: Element): boolean => !userCellFollowsYou(cell);

export const shouldShowUserCell = (cell: Element, mode: FollowingFilterMode): boolean =>
  mode === "all" ? true : shouldShowOneWayFollowCell(cell);

export const filterVisibilityToken = (
  cell: Element,
  mode: FollowingFilterMode,
): "shown" | "hidden" | "cleared" => {
  if (mode === "all") return "cleared";
  return shouldShowUserCell(cell, mode) ? "shown" : "hidden";
};

export const isUserCellVisible = (cell: HTMLElement): boolean =>
  cell.getAttribute(FILTER_ATTR) !== "hidden";

export const extractUserCellHandle = (cell: Element): string | null => {
  for (const link of cell.querySelectorAll('a[href^="/"]')) {
    const href = link.getAttribute("href") ?? "";
    const match = href.match(/^\/([A-Za-z0-9_]+)\/?$/u);
    if (match === null) continue;
    const handle = match[1].toLowerCase();
    if (RESERVED_HANDLES.has(handle)) continue;
    return handle;
  }
  return null;
};

export const findUnfollowButton = (cell: Element): HTMLElement | null =>
  cell.querySelector<HTMLElement>(UNFOLLOW_BUTTON_SELECTOR);

export const applyFollowingListFilterToCell = (
  cell: HTMLElement,
  mode: FollowingFilterMode,
): boolean => {
  const token = filterVisibilityToken(cell, mode);
  const current = cell.getAttribute(FILTER_ATTR);
  if (token === "cleared") {
    if (current === null && cell.style.display === "") return false;
    cell.removeAttribute(FILTER_ATTR);
    cell.style.removeProperty("display");
    return true;
  }
  if (current === token) return false;
  cell.setAttribute(FILTER_ATTR, token);
  cell.style.removeProperty("display");
  if (token === "hidden") {
    const input = cell.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
    if (input !== null) input.checked = false;
  }
  return true;
};

export const applyFollowingListFilter = (
  mode: FollowingFilterMode,
  root: ParentNode = document,
  cells: HTMLElement[] | null = null,
): number => {
  ensureFollowingFilterStyles();
  let changed = 0;
  const targets = cells ?? listUserCells(root);
  for (const cell of targets) {
    if (applyFollowingListFilterToCell(cell, mode)) changed += 1;
  }
  return changed;
};

export const clearFollowingListFilter = (root: ParentNode = document): void => {
  for (const cell of root.querySelectorAll(`${USER_CELL_SELECTOR}[${FILTER_ATTR}]`)) {
    const htmlCell = cell as HTMLElement;
    htmlCell.removeAttribute(FILTER_ATTR);
    htmlCell.style.removeProperty("display");
  }
  removeFollowingFilterStyles();
};

export const listUserCells = (root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(USER_CELL_SELECTOR)];

export const listVisibleUserCells = (root: ParentNode = document): HTMLElement[] =>
  listUserCells(root).filter(isUserCellVisible);

export const collectUserCellsFromNode = (node: Node, bucket: HTMLElement[]): void => {
  if (!(node instanceof Element)) return;
  if (node.matches(USER_CELL_SELECTOR)) {
    bucket.push(node as HTMLElement);
    return;
  }
  for (const cell of node.querySelectorAll<HTMLElement>(USER_CELL_SELECTOR)) {
    bucket.push(cell);
  }
};

export const ensureUserCellCheckbox = (cell: HTMLElement): HTMLInputElement => {
  const existing = cell.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
  if (existing !== null) return existing;

  const wrap = document.createElement("label");
  wrap.setAttribute(CHECKBOX_WRAP_ATTR, "true");
  wrap.style.cssText =
    "display:flex;align-items:flex-start;gap:12px;width:100%;cursor:pointer;box-sizing:border-box;padding:0 4px 0 0";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute(CHECKBOX_INPUT_ATTR, "true");
  input.style.cssText =
    "margin:18px 0 0;width:18px;height:18px;flex:0 0 auto;cursor:pointer;accent-color:rgb(29,155,240)";

  const content = document.createElement("div");
  content.style.cssText = "flex:1 1 auto;min-width:0";

  while (cell.firstChild !== null) {
    content.append(cell.firstChild);
  }

  wrap.append(input, content);
  cell.append(wrap);
  return input;
};

export const removeUserCellCheckboxes = (root: ParentNode = document): void => {
  for (const cell of listUserCells(root)) {
    const wrap = cell.querySelector(`[${CHECKBOX_WRAP_ATTR}]`);
    if (wrap === null) continue;
    const content = wrap.querySelector("div");
    if (content !== null) {
      while (content.firstChild !== null) {
        cell.append(content.firstChild);
      }
    }
    wrap.remove();
  }
};

export const getSelectedHandles = (root: ParentNode = document): string[] => {
  const handles: string[] = [];
  for (const cell of listVisibleUserCells(root)) {
    const input = cell.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
    if (input?.checked !== true) continue;
    const handle = extractUserCellHandle(cell);
    if (handle !== null) handles.push(handle);
  }
  return handles;
};

export const setAllVisibleChecked = (checked: boolean, root: ParentNode = document): void => {
  for (const cell of listVisibleUserCells(root)) {
    const input = ensureUserCellCheckbox(cell);
    input.checked = checked;
  }
};

export const syncCheckboxOnCell = (
  cell: HTMLElement,
  selectedHandles: ReadonlySet<string>,
): boolean => {
  const input = ensureUserCellCheckbox(cell);
  const handle = extractUserCellHandle(cell);
  const nextChecked =
    handle !== null && selectedHandles.has(handle) && isUserCellVisible(cell);
  if (input.checked === nextChecked) return false;
  input.checked = nextChecked;
  return true;
};

export const syncCheckboxSelection = (
  selectedHandles: ReadonlySet<string>,
  root: ParentNode = document,
  cells: HTMLElement[] | null = null,
): number => {
  let changed = 0;
  const targets = cells ?? listUserCells(root);
  for (const cell of targets) {
    if (syncCheckboxOnCell(cell, selectedHandles)) changed += 1;
  }
  return changed;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

export const clickUnfollowConfirmation = async (timeoutMs = 4_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const confirm = document.querySelector<HTMLElement>(CONFIRM_UNFOLLOW_SELECTOR);
    if (confirm !== null) {
      confirm.click();
      await sleep(350);
      return true;
    }
    await sleep(120);
  }
  return false;
};

export const unfollowUserCell = async (cell: HTMLElement): Promise<boolean> => {
  const button = findUnfollowButton(cell);
  if (button === null) return false;
  button.click();
  return clickUnfollowConfirmation();
};

export type UnfollowBatchProgress = {
  done: number;
  total: number;
  handle: string;
  succeeded: boolean;
};

export const unfollowSelectedCells = async (
  cells: HTMLElement[],
  onProgress: (progress: UnfollowBatchProgress) => void,
  delayMs = 700,
): Promise<{ succeeded: number; failed: number }> => {
  let succeeded = 0;
  let failed = 0;
  const total = cells.length;

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const handle = extractUserCellHandle(cell) ?? `#${index + 1}`;
    const ok = await unfollowUserCell(cell);
    if (ok) succeeded += 1;
    else failed += 1;
    onProgress({ done: index + 1, total, handle, succeeded: ok });
    if (index < cells.length - 1) await sleep(delayMs);
  }

  return { succeeded, failed };
};
