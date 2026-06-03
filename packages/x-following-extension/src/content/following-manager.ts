import {
  extractUserCellHandle,
  findUserCellByHandle,
  isFollowingListPage,
  isOwnFollowingListPage,
  readLoggedInUserKey,
  removeFollowingFilterStyles,
  setFollowingFilterMode,
  unfollowSelectedCells,
  type FollowingFilterMode,
} from "../dom/following-filter.js";
import {
  applyCheckboxChangeToSelection,
  applySelectionToViewportCells,
  cellNeedsCheckboxAttach,
  ensureUserCellCheckbox,
  findOrReuseCheckboxInput,
  listLoadedUserCells,
  listViewportUserCells,
  removeUserCellCheckboxes,
  resolveUserCellMount,
  setAllLoadedChecked,
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
const CHECKBOX_RESYNC_DEBOUNCE_MS = 320;
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
let statusText = "勾选用户后可批量取消关注";
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
let checkboxResyncTimer = 0;
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

const readCounts = (): { loadedCount: number; selectedCount: number } => ({
  loadedCount: listLoadedUserCells(filterMode).length,
  selectedCount: selectedHandles.size,
});

const buildToolbarState = (counts: { loadedCount: number; selectedCount: number }): FollowingToolbarState => ({
  filterMode,
  loadedCount: counts.loadedCount,
  selectedCount: counts.selectedCount,
  busy,
  statusText,
});

const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.loadedCount}|${state.selectedCount}|${state.busy}|${state.statusText}`;

const updateToolbar = (force = false): void => {
  const state = buildToolbarState(readCounts());
  const signature = toolbarSignature(state);
  if (!force && signature === lastToolbarSignature) return;
  lastToolbarSignature = signature;
  toolbar?.update(state);
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

  const targets = listViewportUserCells(filterMode);
  let processed = 0;
  for (const cell of targets) {
    syncCheckboxOnViewportCell(cell, attachMissing);
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
  if (checkboxResyncTimer !== 0) {
    window.clearTimeout(checkboxResyncTimer);
    checkboxResyncTimer = 0;
  }
};

const scheduleCheckboxResync = (): void => {
  if (busy) return;
  if (checkboxResyncTimer !== 0) window.clearTimeout(checkboxResyncTimer);
  checkboxResyncTimer = window.setTimeout(() => {
    checkboxResyncTimer = 0;
    applySelectionToViewportCells(selectedHandles, filterMode);
    lastSyncAt = 0;
    syncViewportCheckboxes(true);
  }, CHECKBOX_RESYNC_DEBOUNCE_MS);
};

const startCheckboxGuard = (): void => {
  const column = findPrimaryColumn();
  if (column === null || checkboxGuardObserver !== null) return;
  checkboxGuardObserver = new MutationObserver(() => scheduleCheckboxResync());
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
  removeFollowingFilterStyles();
  removeUserCellCheckboxes();
  selectedHandles.clear();
  busy = false;
  statusText = "勾选用户后可批量取消关注";
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
        if (busy) return;
        filterMode = mode;
        setFollowingFilterMode(mode);
        lastSyncAt = 0;
        runThrottledSync(true);
      },
      onSelectAll: () => {
        if (busy) return;
        setAllLoadedChecked(true, filterMode, selectedHandles);
        updateToolbar(true);
      },
      onClearSelection: () => {
        if (busy) return;
        selectedHandles.clear();
        setAllLoadedChecked(false, filterMode, selectedHandles);
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

  const handles = [...selectedHandles];
  const cells = handles
    .map((handle) => findUserCellByHandle(handle))
    .filter((cell): cell is HTMLElement => cell !== null);

  if (cells.length < handles.length) {
    statusText = `已选 ${handles.length} 人，当前列表仅加载了 ${cells.length} 人；请滚动列表后再取消关注`;
    updateToolbar(true);
    if (cells.length === 0) return;
  }

  if (cells.length === 0) {
    statusText = "请先勾选要取消关注的用户";
    updateToolbar(true);
    return;
  }

  const confirmed = window.confirm(
    cells.length < handles.length
      ? `已选 ${handles.length} 人，当前仅能操作列表中的 ${cells.length} 人。确定取消关注这 ${cells.length} 个账号吗？`
      : `确定要取消关注已选的 ${cells.length} 个账号吗？此操作不可撤销。`,
  );
  if (!confirmed) return;

  busy = true;
  statusText = `正在取消关注 0 / ${cells.length}…`;
  updateToolbar(true);

  const result = await unfollowSelectedCells(cells, (progress) => {
    statusText = progress.succeeded
      ? `正在取消关注 ${progress.done} / ${progress.total}（@${progress.handle}）`
      : `跳过 @${progress.handle}（${progress.done} / ${progress.total}）`;
    updateToolbar(true);
  });

  selectedHandles.clear();
  setAllLoadedChecked(false, filterMode, selectedHandles);
  busy = false;
  statusText = `完成：成功 ${result.succeeded}，失败 ${result.failed}`;
  lastSyncAt = 0;
  runThrottledSync(true);
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
    console.error("[xfm] 关注列表助手启动失败", error);
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
