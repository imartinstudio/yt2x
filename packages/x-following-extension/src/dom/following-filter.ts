export const USER_CELL_SELECTOR = '[data-testid="UserCell"]';
const FOLLOWS_YOU_INDICATOR = '[data-testid="userFollowIndicator"]';
const UNFOLLOW_BUTTON_SELECTOR = '[data-testid$="-unfollow"]';
const CONFIRM_UNFOLLOW_SELECTOR = '[data-testid="confirmationSheetConfirm"]';
const FILTER_STYLE_ID = "xfm-following-filter-style";
const FILTER_HTML_ATTR = "data-xfm-filter";
const CHECKBOX_HIT_SELECTOR = "[data-xfm-follow-select-hit]";

const FOLLOWS_YOU_LABELS = /^(Follows you|关注了你)$/u;
const HANDLE_FROM_HREF = /^\/@?([A-Za-z0-9_]+)\/?$/u;

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

export {
  followingPageUserKey as followingListUsername,
  isFollowingListPage,
  isOwnFollowingListPage,
  readLoggedInUserKey,
} from "./x-session.js";

const filterCss = (mode: FollowingFilterMode): string => {
  const css: string[] = [];
  if (mode === "one-way") {
    css.push(
      `html[${FILTER_HTML_ATTR}="one-way"] :not(section):not([data-testid="primaryColumn"]):has(> [data-testid="UserCell"]:only-child:has(${FOLLOWS_YOU_INDICATOR})){display:none!important}`,
      `html[${FILTER_HTML_ATTR}="one-way"] :not(section):not([data-testid="primaryColumn"]):has(> ${CHECKBOX_HIT_SELECTOR} + [data-testid="UserCell"]:has(${FOLLOWS_YOU_INDICATOR})){display:none!important}`,
      `html[${FILTER_HTML_ATTR}="one-way"] [data-testid="UserCell"]:has(${FOLLOWS_YOU_INDICATOR}){display:none!important}`,
      `html[${FILTER_HTML_ATTR}="one-way"] ${CHECKBOX_HIT_SELECTOR}:has(+ [data-testid="UserCell"]:has(${FOLLOWS_YOU_INDICATOR})){display:none!important;pointer-events:none!important}`,
    );
  }
  return css.join("\n");
};

export const setFollowingFilterMode = (mode: FollowingFilterMode): void => {
  let style = document.getElementById(FILTER_STYLE_ID) as HTMLStyleElement | null;
  if (style === null) {
    style = document.createElement("style");
    style.id = FILTER_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = filterCss(mode);
  if (mode === "one-way") {
    document.documentElement.setAttribute(FILTER_HTML_ATTR, "one-way");
  } else {
    document.documentElement.removeAttribute(FILTER_HTML_ATTR);
  }
};

export const removeFollowingFilterStyles = (): void => {
  document.getElementById(FILTER_STYLE_ID)?.remove();
  document.documentElement.removeAttribute(FILTER_HTML_ATTR);
};

export const userCellFollowsYou = (cell: Element): boolean => {
  if (cell.querySelector(FOLLOWS_YOU_INDICATOR) !== null) return true;
  return [...cell.querySelectorAll("span")].some((el) =>
    FOLLOWS_YOU_LABELS.test(el.textContent?.trim() ?? ""),
  );
};

export const shouldShowOneWayFollowCell = (cell: Element): boolean => !userCellFollowsYou(cell);

export const shouldShowCheckboxOnCell = (
  cell: Element,
  mode: FollowingFilterMode,
): boolean => (mode === "all" ? true : shouldShowOneWayFollowCell(cell));

const parseHandleFromHref = (href: string): string | null => {
  const path = href.split("?")[0]?.split("#")[0] ?? "";
  const match = path.match(HANDLE_FROM_HREF);
  const rawHandle = match?.[1];
  if (rawHandle === undefined) return null;
  const handle = rawHandle.toLowerCase();
  if (RESERVED_HANDLES.has(handle)) return null;
  return handle;
};

export const extractUserCellHandle = (cell: Element): string | null => {
  const frequency = new Map<string, number>();
  for (const link of cell.querySelectorAll('a[href^="/"]')) {
    const handle = parseHandleFromHref(link.getAttribute("href") ?? "");
    if (handle !== null) {
      frequency.set(handle, (frequency.get(handle) ?? 0) + 1);
    }
  }
  if (frequency.size === 0) return null;
  // 返回出现频率最高的 handle（profile handle 出现在头像+名称处，次数 > bio 中 @ 引用）
  return [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export const findUnfollowButton = (cell: Element): HTMLElement | null =>
  cell.querySelector<HTMLElement>(UNFOLLOW_BUTTON_SELECTOR);

export const listUserCells = (root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(USER_CELL_SELECTOR)];

export const findUserCellByHandle = (
  handle: string,
  root: ParentNode = document,
): HTMLElement | null => {
  const normalized = handle.toLowerCase();
  for (const cell of listUserCells(root)) {
    if (extractUserCellHandle(cell) === normalized) return cell;
  }
  return null;
};

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
  delayMs = 1_000,
): Promise<{ succeeded: number; failed: number }> => {
  let succeeded = 0;
  let failed = 0;
  const total = cells.length;

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined) continue;
    const handle = extractUserCellHandle(cell) ?? `#${index + 1}`;
    const ok = await unfollowUserCell(cell);
    if (ok) succeeded += 1;
    else failed += 1;
    onProgress({ done: index + 1, total, handle, succeeded: ok });
    if (index < cells.length - 1) await sleep(delayMs);
  }

  return { succeeded, failed };
};
