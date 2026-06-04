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

const PROFILE_LINK_SELECTORS = [
  'a[data-testid="AppTabBar_Profile_Link"]',
  'a[data-testid="SideNav_AccountSwitcher_Button"]',
  'a[data-testid="DashButton_ProfileIcon_Link"]',
  'a[data-testid="AccountSwitcher_Profile_Link"]',
] as const;

/** 将个人主页路径规范为 handle 或 `id:<numeric>`，便于与 following 页路径比对。 */
export const profilePathToUserKey = (pathname: string): string | null => {
  const segments = pathname.replace(/^\//u, "").split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments[0] === "i" && segments[1] === "user" && segments[2]) {
    return `id:${segments[2].toLowerCase()}`;
  }
  const handle = segments[0]?.toLowerCase();
  if (handle === undefined || RESERVED_HANDLES.has(handle)) return null;
  return handle;
};

export const followingPageUserKey = (pathname: string): string | null => {
  if (!/\/following\/?$/u.test(pathname)) return null;
  return profilePathToUserKey(pathname.replace(/\/following\/?$/u, "") || "/");
};

export const isFollowingListPage = (pathname: string): boolean =>
  followingPageUserKey(pathname) !== null;

/** 收集侧栏/底栏等所有「当前账号」入口上的 profile key，避免只读到第一个选择器。 */
export const collectProfileUserKeys = (root: ParentNode = document): string[] => {
  const keys = new Set<string>();
  for (const selector of PROFILE_LINK_SELECTORS) {
    for (const link of root.querySelectorAll<HTMLAnchorElement>(selector)) {
      const key = profilePathToUserKey(link.pathname);
      if (key !== null) keys.add(key);
    }
  }
  return [...keys];
};

export const readLoggedInUserKey = (root: ParentNode = document): string | null => {
  const keys = collectProfileUserKeys(root);
  if (keys.length > 0) return keys[0] ?? null;

  const settingsLink = root.querySelector<HTMLAnchorElement>('a[href="/settings/profile"]');
  if (settingsLink !== null) {
    const accountLink = root.querySelector<HTMLAnchorElement>(
      'a[data-testid="SideNav_AccountSwitcher_Button"], a[href^="/"][role="link"]',
    );
    const key = accountLink === null ? null : profilePathToUserKey(accountLink.pathname);
    if (key !== null) return key;
  }

  return null;
};

/** 侧栏 profile 未就绪时：主栏 tab 的 following 链接与路径一致则视为自己的列表。 */
export const inferOwnFollowingFromTabs = (
  pathname: string,
  root: ParentNode = document,
): boolean => {
  const pageKey = followingPageUserKey(pathname);
  if (pageKey === null) return false;
  const column = root.querySelector('[data-testid="primaryColumn"]');
  if (column === null) return false;
  const selectedTab = column.querySelector<HTMLAnchorElement>(
    `a[href="/${pageKey}/following"][aria-selected="true"], a[href="/${pageKey}/following"][aria-current="page"]`,
  );
  return selectedTab !== null;
};

const FOLLOWING_TAB_ACTIVE_SELECTORS = [
  'a[role="tab"][aria-selected="true"]',
  'a[aria-selected="true"]',
] as const;

const FOLLOWING_TAB_HREF = /\/following\/?$/u;
const FOLLOWING_TAB_LABEL = /^(正在关注|Following)$/u;

/** 确认「正在关注」tab 处于激活态，而非关注者/认证关注者等子 tab。 */
export const isFollowingTabActive = (root: ParentNode = document): boolean => {
  for (const selector of FOLLOWING_TAB_ACTIVE_SELECTORS) {
    for (const tab of root.querySelectorAll<HTMLAnchorElement>(selector)) {
      const href = tab.getAttribute("href") ?? "";
      const label = tab.textContent?.trim() ?? "";
      if (FOLLOWING_TAB_HREF.test(href) || FOLLOWING_TAB_LABEL.test(label)) {
        return true;
      }
    }
  }
  return false;
};

export const isOwnFollowingListPage = (
  pathname: string,
  loggedInUserKey: string | null,
  root: ParentNode = document,
): boolean => {
  const pageKey = followingPageUserKey(pathname);
  if (pageKey === null) return false;

  // 必须「正在关注」tab 激活（非关注者/认证关注者）
  if (!isFollowingTabActive(root)) return false;

  const keys = new Set(collectProfileUserKeys(root));
  if (loggedInUserKey !== null) keys.add(loggedInUserKey);

  if (keys.size > 0) return keys.has(pageKey);
  return inferOwnFollowingFromTabs(pathname, root);
};
