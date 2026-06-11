import {
  extractUserCellHandle,
  findUserCellByHandle,
  isFollowingListPage,
  isOwnFollowingListPage,
  readLoggedInUserKey,
  removeFollowingFilterStyles,
  setFollowingFilterMode,
  unfollowUserCell,
  userCellFollowsYou,
  type FollowingFilterMode,
} from "../dom/following-filter.js";
import {
  applyCheckboxChangeToSelection,
  applySelectionToViewportCells,
  cellNeedsCheckboxAttach,
  clearExistingLoadedChecked,
  ensureUserCellCheckbox,
  findOrReuseCheckboxInput,
  listLoadedUserCells,
  listViewportUserCells,
  removeUserCellCheckboxes,
  cleanupCheckboxArtifacts,
  resolveUserCellMount,
  removeCheckboxSpaceReservation,
  reserveCheckboxSpace,
  injectCheckboxTheme,
  syncCheckboxOnCell,
} from "../dom/user-cell-checkbox.js";
import {
  applyToolbarStickyLayout,
  findFollowingListInsertPoint,
  findFollowingToolbarFallbackAnchor,
  findPrimaryColumn,
  isToolbarMountedAtListTop,
  listFollowingToolbarHosts,
  mountFollowingToolbar,
  removeAllFollowingToolbarHosts,
  TOOLBAR_HOST_ATTR,
  type FollowingToolbar,
  type FollowingToolbarState,
} from "../ui/following-toolbar.js";

declare global {
  interface Window {
    __xfmCoreInit?: boolean;
    __xfmStatus?: () => Record<string, unknown>;
    __xfmManagerSlot?: { destroy: () => void };
  }
}

const MIN_SYNC_INTERVAL_MS = 800;
const SCROLL_SYNC_DEBOUNCE_MS = 200;
const ACTIVATION_RETRY_MS = 500;
const ACTIVATION_MAX_ATTEMPTS = 80;
const TOOLBAR_GUARD_DEBOUNCE_MS = 150;
const ROUTE_REACTIVATE_DEBOUNCE_MS = 80;
const WATCHDOG_INTERVAL_MS = 2_000;

let trackedPathname = "";
const MAX_CELLS_PER_PASS = 40;

const selectedHandles = new Set<string>();

let filterMode: FollowingFilterMode = "one-way";
let toolbar: FollowingToolbar | null = null;
let busy = false;
let statusText = "勾选后批量取关";
const seenHandles = new Set<string>();
const seenOneWayHandles = new Set<string>();
let activationAttempts = 0;
let activationRetryId = 0;
let syncDebounceTimer = 0;
let syncLoopTimer = 0;
let lastSyncAt = 0;
let lastToolbarSignature = "";
let pageActive = false;
let toolbarGuardObserver: MutationObserver | null = null;
let toolbarGuardTimer = 0;
let checkboxGuardObserver: MutationObserver | null = null;
let scrollCheckboxResyncRaf = 0;
let watchdogTimer = 0;

const hasToolbarInDom = (): boolean => listFollowingToolbarHosts().length > 0;

/** 保留当前实例持有的工具栏，移除重复或失去绑定的节点。 */
const dedupeToolbarHostsInDom = (): void => {
  const hosts = listFollowingToolbarHosts();
  if (hosts.length === 0) {
    if (toolbar !== null && !toolbar.root.isConnected) toolbar = null;
    return;
  }

  const owned =
    toolbar !== null && toolbar.root.isConnected && hosts.includes(toolbar.root)
      ? toolbar.root
      : null;

  for (const host of hosts) {
    if (host !== owned) host.remove();
  }

  if (owned === null) {
    removeAllFollowingToolbarHosts();
    toolbar = null;
    lastToolbarSignature = "";
  }
};

const stopWatchdog = (): void => {
  if (watchdogTimer === 0) return;
  window.clearInterval(watchdogTimer);
  watchdogTimer = 0;
};

const startWatchdog = (): void => {
  stopWatchdog();
  watchdogTimer = window.setInterval(() => tryActivateFollowingPage(), WATCHDOG_INTERVAL_MS);
};

const takeOverManagerSlot = (): void => {
  window.__xfmManagerSlot?.destroy();
  window.__xfmManagerSlot = {
    destroy: () => {
      stopActivationRetry();
      stopSyncLoop();
      stopToolbarGuard();
      stopCheckboxGuard();
      if (scrollCheckboxResyncRaf !== 0) {
        window.cancelAnimationFrame(scrollCheckboxResyncRaf);
        scrollCheckboxResyncRaf = 0;
      }
      stopWatchdog();
      destroyPageState();
    },
  };
};

const activeListHandles = (): ReadonlySet<string> =>
  filterMode === "one-way" ? seenOneWayHandles : seenHandles;

const selectedCountForActiveList = (): number => {
  const handles = activeListHandles();
  let count = 0;
  for (const handle of selectedHandles) {
    if (handles.has(handle)) count += 1;
  }
  return count;
};

const readCounts = (): { loadedCount: number; selectedCount: number } => {
  const cells = listLoadedUserCells(filterMode);
  // 追踪所有已加载 cell 的 handle，不仅限于视口
  for (const cell of cells) {
    const handle = extractUserCellHandle(cell);
    if (handle !== null) {
      seenHandles.add(handle);
      if (!userCellFollowsYou(cell)) seenOneWayHandles.add(handle);
    }
  }
  return { loadedCount: activeListHandles().size, selectedCount: selectedCountForActiveList() };
};

const buildToolbarState = (counts: { loadedCount: number; selectedCount: number }): FollowingToolbarState => ({
  filterMode,
  loadedCount: counts.loadedCount,
  selectedCount: counts.selectedCount,
  busy,
  statusText,
  phase: "normal",
  oneWayCount: seenOneWayHandles.size,
});

/** 将当前筛选列表中的所有 handle 设为选中。 */
const selectAllSeenHandles = (): void => {
  selectedHandles.clear();
  for (const handle of activeListHandles()) selectedHandles.add(handle);
  syncViewportCheckboxes(true);
};

const clearSelection = (): void => {
  selectedHandles.clear();
  cleanupCheckboxArtifacts(filterMode);
  clearExistingLoadedChecked(filterMode, selectedHandles);
};

const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.loadedCount}|${state.selectedCount}|${state.oneWayCount}|${state.busy}|${state.statusText}|${state.phase}`;

const updateToolbar = (force = false): void => {
  const state = buildToolbarState(readCounts());
  const signature = toolbarSignature(state);
  if (!force && signature === lastToolbarSignature) return;
  lastToolbarSignature = signature;
  toolbar?.update(state);
};

const notifyListLayoutChanged = (): void => {
  window.dispatchEvent(new Event("resize"));
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event("scroll"));
  });
};

const handleFilterModeChange = (mode: FollowingFilterMode): void => {
  if (busy || mode === filterMode) return;
  cleanupCheckboxArtifacts(filterMode);
  filterMode = mode;
  setFollowingFilterMode(mode);
  clearSelection();
  cleanupCheckboxArtifacts(filterMode);
  notifyListLayoutChanged();
  lastSyncAt = 0;
  runThrottledSync(true);
  updateToolbar(true);
};

const bindCheckboxListener = (input: HTMLInputElement): void => {
  if (input.dataset.xfmBound === "true") return;
  input.dataset.xfmBound = "true";
  input.addEventListener("change", () => {
    applyCheckboxChangeToSelection(input, selectedHandles);
    updateToolbar();
  });
};

const bindCheckboxOnCellIfPresent = (cell: HTMLElement): void => {
  const mount = resolveUserCellMount(cell);
  const handle = extractUserCellHandle(mount.userCell);
  const input = findOrReuseCheckboxInput(mount, handle);
  if (input !== null) bindCheckboxListener(input);
};

const syncCheckboxOnViewportCell = (cell: HTMLElement, attachIfMissing: boolean): void => {
  try {
    if (attachIfMissing && cellNeedsCheckboxAttach(cell)) {
      syncCheckboxOnCell(cell, selectedHandles, filterMode);
      bindCheckboxListener(ensureUserCellCheckbox(cell));
      return;
    }
    syncCheckboxOnCell(cell, selectedHandles, filterMode);
    bindCheckboxOnCellIfPresent(cell);
  } catch (error) {
    console.error("[xfm] 勾选框同步失败", error);
  }
};

const syncViewportCheckboxes = (attachMissing = true): number => {
  if (!isFollowingListPage(location.pathname)) return 0;
  const loggedInKey = readLoggedInUserKey();
  if (!isOwnFollowingListPage(location.pathname, loggedInKey, document)) return 0;

  cleanupCheckboxArtifacts(filterMode);
  const targets = listViewportUserCells(filterMode);
  let processed = 0;
  for (const cell of targets) {
    syncCheckboxOnViewportCell(cell, attachMissing);
    // 记录已发现的唯一 handle（虚拟列表安全计数）
    const handle = extractUserCellHandle(cell);
    if (handle !== null) {
      seenHandles.add(handle);
      if (!userCellFollowsYou(cell)) seenOneWayHandles.add(handle);
    }
    processed += 1;
    if (processed >= MAX_CELLS_PER_PASS) break;
  }
  if (toolbar !== null) updateToolbar();
  return processed;
};

const runThrottledSync = (force = false): void => {
  if (busy) return;
  if (!pageActive && !hasToolbarInDom()) return;
  const now = Date.now();
  if (!force && now - lastSyncAt < MIN_SYNC_INTERVAL_MS) return;
  lastSyncAt = now;
  syncViewportCheckboxes();
};

const scheduleScrollCheckboxStateResync = (): void => {
  if (busy || !pageActive) return;
  if (scrollCheckboxResyncRaf !== 0) return;
  scrollCheckboxResyncRaf = window.requestAnimationFrame(() => {
    scrollCheckboxResyncRaf = 0;
    if (!isFollowingListPage(location.pathname)) return;
    applySelectionToViewportCells(selectedHandles, filterMode);
  });
};

const scheduleSync = (force = false): void => {
  scheduleScrollCheckboxStateResync();
  if (syncDebounceTimer !== 0) window.clearTimeout(syncDebounceTimer);
  syncDebounceTimer = window.setTimeout(() => {
    syncDebounceTimer = 0;
    runThrottledSync(force);
  }, force ? 0 : SCROLL_SYNC_DEBOUNCE_MS);
};

const startSyncLoop = (): void => {
  if (syncLoopTimer !== 0) return;
  syncLoopTimer = window.setInterval(() => {
    runThrottledSync(false);
    cleanupCheckboxArtifacts(filterMode);
    // 全量同步所有已加载 cell 的状态（包含离屏 cell，防止虚拟列表回收残留）
    for (const cell of listLoadedUserCells(filterMode)) {
      syncCheckboxOnCell(cell, selectedHandles, filterMode);
    }
  }, MIN_SYNC_INTERVAL_MS + 400);
};

const stopSyncLoop = (): void => {
  if (syncDebounceTimer !== 0) {
    window.clearTimeout(syncDebounceTimer);
    syncDebounceTimer = 0;
  }
  if (syncLoopTimer !== 0) {
    window.clearInterval(syncLoopTimer);
    syncLoopTimer = 0;
  }
};

const stopToolbarGuard = (): void => {
  toolbarGuardObserver?.disconnect();
  toolbarGuardObserver = null;
  if (toolbarGuardTimer !== 0) {
    window.clearTimeout(toolbarGuardTimer);
    toolbarGuardTimer = 0;
  }
};

const stopCheckboxGuard = (): void => {
  checkboxGuardObserver?.disconnect();
  checkboxGuardObserver = null;
};

const startCheckboxGuard = (): void => {
  const column = findPrimaryColumn();
  if (column === null || checkboxGuardObserver !== null) return;
  checkboxGuardObserver = new MutationObserver(() => {
    if (busy) return;
    scheduleScrollCheckboxStateResync();
    runThrottledSync(true);
  });
  checkboxGuardObserver.observe(column, { childList: true, subtree: true });
};

const scheduleToolbarGuard = (): void => {
  if (!isFollowingListPage(location.pathname)) return;
  if (toolbarGuardTimer !== 0) window.clearTimeout(toolbarGuardTimer);
  toolbarGuardTimer = window.setTimeout(() => {
    toolbarGuardTimer = 0;
    if (!isFollowingListPage(location.pathname)) return;
    const loggedInKey = readLoggedInUserKey();
    if (!isOwnFollowingListPage(location.pathname, loggedInKey, document)) return;
    dedupeToolbarHostsInDom();
    if (!hasToolbarInDom()) ensureToolbar();
    else refreshToolbarStickyTop();
  }, TOOLBAR_GUARD_DEBOUNCE_MS);
};

const startToolbarGuard = (): void => {
  const column = findPrimaryColumn();
  if (column === null || toolbarGuardObserver !== null) return;
  toolbarGuardObserver = new MutationObserver(() => scheduleToolbarGuard());
  toolbarGuardObserver.observe(column, { childList: true, subtree: true });
};

const destroyPageState = (): void => {
  stopActivationRetry();
  stopSyncLoop();
  stopToolbarGuard();
  stopCheckboxGuard();
  pageActive = false;
  toolbar?.remove();
  toolbar = null;
  seenHandles.clear();
  seenOneWayHandles.clear();
  removeFollowingFilterStyles();
  removeCheckboxSpaceReservation();
  document.getElementById("xfm-checkbox-theme-style")?.remove();
  removeUserCellCheckboxes();
  selectedHandles.clear();
  busy = false;
  statusText = "勾选后批量取关";
  lastToolbarSignature = "";
  lastSyncAt = 0;
};

const ensureToolbar = (): boolean => {
  dedupeToolbarHostsInDom();

  const insertPoint = findFollowingListInsertPoint();
  const fallbackAnchor = findFollowingToolbarFallbackAnchor();

  if (toolbar !== null && toolbar.root.isConnected) {
    if (insertPoint === null || isToolbarMountedAtListTop(toolbar.root, insertPoint)) {
      dedupeToolbarHostsInDom();
      updateToolbar(true);
      return true;
    }
    toolbar.remove();
    toolbar = null;
    lastToolbarSignature = "";
  }

  if (listFollowingToolbarHosts().length > 0) {
    removeAllFollowingToolbarHosts();
    toolbar = null;
    lastToolbarSignature = "";
  }

  if (insertPoint === null && fallbackAnchor === null) return false;

  const counts = readCounts();
  toolbar = mountFollowingToolbar(
    insertPoint,
    fallbackAnchor,
    {
      onFilterModeChange: (mode) => {
        handleFilterModeChange(mode);
      },
      onSelectAll: () => {
        if (busy) return;
        selectAllSeenHandles();
        updateToolbar(true);
      },
      onClearSelection: () => {
        if (busy) return;
        selectedHandles.clear();
        clearExistingLoadedChecked(filterMode, selectedHandles);
        updateToolbar(true);
      },
      onUnfollowSelected: () => {
        void handleUnfollowSelected();
      },
    },
    buildToolbarState(counts),
  );
  lastToolbarSignature = toolbarSignature(buildToolbarState(counts));
  return hasToolbarInDom();
};

const activatePageUi = (): boolean => {
  if (!isFollowingListPage(location.pathname)) {
    destroyPageState();
    return false;
  }

  const loggedInKey = readLoggedInUserKey();
  if (!isOwnFollowingListPage(location.pathname, loggedInKey, document)) {
    destroyPageState();
    return false;
  }

  reserveCheckboxSpace();
  injectCheckboxTheme();
  setFollowingFilterMode(filterMode);
  const toolbarReady = ensureToolbar();
  pageActive = toolbarReady;

  if (pageActive) {
    startToolbarGuard();
    startCheckboxGuard();
    refreshToolbarStickyTop();
    runThrottledSync(true);
    startSyncLoop();
  }

  return pageActive;
};

const handleUnfollowSelected = async (): Promise<void> => {
  if (busy) return;

  const remainingHandles = new Set(selectedHandles);
  if (remainingHandles.size === 0) {
    statusText = "请先勾选要取消关注的用户";
    updateToolbar(true);
    return;
  }

  // 找出当前 DOM 中可操作的 cell
  const findLoadedCells = (): HTMLElement[] => {
    const cells: HTMLElement[] = [];
    for (const handle of remainingHandles) {
      const cell = findUserCellByHandle(handle);
      if (cell !== null) cells.push(cell);
    }
    return cells;
  };

  const initialCells = findLoadedCells();

  // 玻璃 Dialog 确认
  if (toolbar === null) return;
  const confirmed = await toolbar.confirmUnfollow(initialCells.length, remainingHandles.size);
  if (!confirmed) return;

  busy = true;

  const logBuffer: { handle: string; succeeded: boolean }[] = [];
  let totalSucceeded = 0;
  let totalFailed = 0;
  const totalSelected = remainingHandles.size;

  const pushProgress = (): void => {
    if (toolbar === null) return;
    toolbar.update({
      ...buildToolbarState({ ...readCounts(), selectedCount: remainingHandles.size }),
      busy: true,
      phase: "progress",
      progress: { done: totalSucceeded + totalFailed, total: totalSelected, recentLog: logBuffer.slice(-3) },
    });
  };

  // 自动滚动加载 + 批量取关循环
  const SCROLL_STEP = 800;
  const SCROLL_WAIT_MS = 1_200;
  const MAX_SCROLL_ATTEMPTS = 50;

  for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS && remainingHandles.size > 0; attempt += 1) {
    const batch = findLoadedCells();
    if (batch.length === 0) {
      // 没有可操作的 cell，向下滚动加载更多
      window.scrollBy(0, SCROLL_STEP);
      await new Promise((r) => window.setTimeout(r, SCROLL_WAIT_MS));
      continue;
    }

    pushProgress();

    for (let i = 0; i < batch.length; i += 1) {
      const cell = batch[i];
      if (cell === undefined) continue;
      const handle = extractUserCellHandle(cell);
      const ok = await unfollowUserCell(cell);
      if (ok) {
        totalSucceeded += 1;
        if (handle !== null) remainingHandles.delete(handle);
      } else {
        totalFailed += 1;
      }
      logBuffer.push({ handle: handle ?? `#${i + 1}`, succeeded: ok });
      pushProgress();

      // 间距 1 秒
      if (i < batch.length - 1) {
        await new Promise((r) => window.setTimeout(r, 1_000));
      }
    }

    // 滚动加载下一批
    if (remainingHandles.size > 0) {
      window.scrollBy(0, SCROLL_STEP);
      await new Promise((r) => window.setTimeout(r, SCROLL_WAIT_MS));
    }
  }

  selectedHandles.clear();
  clearExistingLoadedChecked(filterMode, selectedHandles);
  busy = false;
  statusText = totalFailed > 0
    ? `完成：成功 ${totalSucceeded}，失败 ${totalFailed}`
    : `完成：成功取消关注 ${totalSucceeded} 人`;

  if (toolbar !== null) {
    toolbar.update({
      ...buildToolbarState({ ...readCounts(), selectedCount: 0 }),
      busy: false,
      phase: "complete",
      completeResult: { succeeded: totalSucceeded, failed: totalFailed },
    });
  }

  lastSyncAt = 0;
  runThrottledSync(true);

  window.setTimeout(() => {
    statusText = "勾选后批量取关";
    updateToolbar(true);
  }, 3_000);
};

const stopActivationRetry = (): void => {
  if (activationRetryId !== 0) {
    window.clearInterval(activationRetryId);
    activationRetryId = 0;
  }
  activationAttempts = 0;
};

const startActivationRetry = (): void => {
  stopActivationRetry();
  const tick = (): void => {
    activationAttempts += 1;
    const ready = activatePageUi();
    const done = (ready && hasToolbarInDom()) || activationAttempts >= ACTIVATION_MAX_ATTEMPTS;
    if (done) stopActivationRetry();
  };
  tick();
  activationRetryId = window.setInterval(tick, ACTIVATION_RETRY_MS);
};

const tryActivateFollowingPage = (): void => {
  if (!isFollowingListPage(location.pathname)) {
    destroyPageState();
    return;
  }
  if (!hasToolbarInDom() || !pageActive) {
    startActivationRetry();
    return;
  }
  lastSyncAt = 0;
  syncViewportCheckboxes();
};

let routeReactivateTimer = 0;

const notifyPathnameChange = (): void => {
  const pathname = location.pathname;
  if (pathname === trackedPathname) return;
  trackedPathname = pathname;
  destroyPageState();
  tryActivateFollowingPage();
};

const scheduleRouteReactivate = (): void => {
  if (routeReactivateTimer !== 0) window.clearTimeout(routeReactivateTimer);
  routeReactivateTimer = window.setTimeout(() => {
    routeReactivateTimer = 0;
    notifyPathnameChange();
  }, ROUTE_REACTIVATE_DEBOUNCE_MS);
};

const patchHistoryNavigation = (): void => {
  trackedPathname = location.pathname;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      scheduleRouteReactivate();
      return result;
    };
  }
  window.addEventListener("popstate", notifyPathnameChange);
};

const refreshToolbarStickyTop = (): void => {
  const host = document.querySelector<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`) ?? toolbar?.root ?? null;
  if (host === null) return;
  applyToolbarStickyLayout(host);
};

const installPassiveSyncTriggers = (): void => {
  window.addEventListener(
    "scroll",
    () => {
      refreshToolbarStickyTop();
      scheduleSync(false);
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    "resize",
    () => {
      refreshToolbarStickyTop();
      scheduleSync(false);
    },
    { passive: true },
  );
};

const buildStatus = (): Record<string, unknown> => ({
  path: location.pathname,
  marker: document.documentElement?.getAttribute("data-xfm-extension"),
  coreInit: window.__xfmCoreInit === true,
  pageActive,
  toolbar: hasToolbarInDom(),
  checkboxes: document.querySelectorAll("[data-xfm-follow-select-input]").length,
  insertPoint: findFollowingListInsertPoint() !== null,
  primaryColumn: findPrimaryColumn() !== null,
  ownPage: isOwnFollowingListPage(location.pathname, readLoggedInUserKey(), document),
});

const initCoreOnce = (): void => {
  if (window.__xfmCoreInit) return;
  window.__xfmCoreInit = true;
  document.documentElement?.setAttribute("data-xfm-extension", "loaded");
  patchHistoryNavigation();
  installPassiveSyncTriggers();
  window.__xfmStatus = buildStatus;
};

const bootstrap = (): void => {
  try {
    initCoreOnce();
    takeOverManagerSlot();
    startWatchdog();
    tryActivateFollowingPage();
  } catch (error) {
    console.error("[xfm] X 清道夫启动失败", error);
  }
};

const runBootstrap = (): void => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    return;
  }
  bootstrap();
};

runBootstrap();
