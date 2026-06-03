import {
  applyFollowingListFilter,
  CHECKBOX_INPUT_ATTR,
  clearFollowingListFilter,
  collectUserCellsFromNode,
  ensureUserCellCheckbox,
  getSelectedHandles,
  isOwnFollowingListPage,
  listUserCells,
  listVisibleUserCells,
  removeUserCellCheckboxes,
  setAllVisibleChecked,
  syncCheckboxOnCell,
  unfollowSelectedCells,
  type FollowingFilterMode,
} from "../dom/following-filter.js";
import {
  findFollowingToolbarAnchor,
  mountFollowingToolbar,
  type FollowingToolbar,
  type FollowingToolbarState,
} from "../ui/following-toolbar.js";

const REFRESH_DEBOUNCE_MS = 450;
const LIST_OBSERVER_SELECTOR = '[data-testid="primaryColumn"]';

const readLoggedInUsername = (): string | null => {
  const profileLink = document.querySelector<HTMLAnchorElement>(
    'a[data-testid="AppTabBar_Profile_Link"]',
  );
  const segment = profileLink?.pathname.replace(/^\//u, "").split("/")[0]?.trim();
  return segment ? segment.toLowerCase() : null;
};

const selectedHandles = new Set<string>();
const preparedCells = new WeakSet<HTMLElement>();

let filterMode: FollowingFilterMode = "one-way";
let toolbar: FollowingToolbar | null = null;
let busy = false;
let statusText = "勾选用户后可批量取消关注";
let refreshTimer = 0;
let refreshRaf = 0;
let listObserver: MutationObserver | null = null;
let lastToolbarSignature = "";

const buildToolbarState = (): FollowingToolbarState => ({
  filterMode,
  visibleCount: listVisibleUserCells().length,
  selectedCount: getSelectedHandles().length,
  busy,
  statusText,
});

const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.visibleCount}|${state.selectedCount}|${state.busy}|${state.statusText}`;

const updateToolbar = (force = false): void => {
  const state = buildToolbarState();
  const signature = toolbarSignature(state);
  if (!force && signature === lastToolbarSignature) return;
  lastToolbarSignature = signature;
  toolbar?.update(state);
};

const refreshSelectionFromInputs = (): void => {
  selectedHandles.clear();
  for (const handle of getSelectedHandles()) {
    selectedHandles.add(handle);
  }
};

const bindCheckboxListener = (input: HTMLInputElement): void => {
  if (input.dataset.xfmBound === "true") return;
  input.dataset.xfmBound = "true";
  input.addEventListener("change", () => {
    refreshSelectionFromInputs();
    updateToolbar();
  });
};

const prepareUserCell = (cell: HTMLElement, fullPass: boolean): void => {
  if (!fullPass && preparedCells.has(cell)) return;
  applyFollowingListFilter(filterMode, document, [cell]);
  const input = ensureUserCellCheckbox(cell);
  syncCheckboxOnCell(cell, selectedHandles);
  bindCheckboxListener(input);
  preparedCells.add(cell);
};

const prepareUserCells = (cells: HTMLElement[], fullPass: boolean): void => {
  if (cells.length === 0) return;
  let changed = 0;
  for (const cell of cells) {
    const before = cell.getAttribute("data-xfm-follow-filter");
    prepareUserCell(cell, fullPass);
    if (cell.getAttribute("data-xfm-follow-filter") !== before) changed += 1;
  }
  if (changed > 0 || fullPass) updateToolbar();
};

const silentRefreshNewCells = (mutations: MutationRecord[]): void => {
  const pending: HTMLElement[] = [];
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      collectUserCellsFromNode(node, pending);
    }
  }
  if (pending.length === 0) return;
  prepareUserCells(pending, false);
};

const applyFullPageState = (): void => {
  const cells = listUserCells();
  applyFollowingListFilter(filterMode, document, cells);
  for (const cell of cells) {
    const input = ensureUserCellCheckbox(cell);
    syncCheckboxOnCell(cell, selectedHandles);
    bindCheckboxListener(input);
    preparedCells.add(cell);
  }
  updateToolbar(true);
};

const destroyPageState = (): void => {
  listObserver?.disconnect();
  listObserver = null;
  toolbar?.remove();
  toolbar = null;
  clearFollowingListFilter();
  removeUserCellCheckboxes();
  selectedHandles.clear();
  busy = false;
  statusText = "勾选用户后可批量取消关注";
  lastToolbarSignature = "";
};

const ensureListObserver = (root: HTMLElement): void => {
  if (listObserver !== null) return;
  listObserver = new MutationObserver((mutations) => {
    scheduleSilentRefresh(mutations);
  });
  listObserver.observe(root, { childList: true, subtree: true });
};

const ensureToolbar = (): void => {
  if (toolbar !== null) return;
  const anchor = findFollowingToolbarAnchor();
  if (anchor === null) return;

  toolbar = mountFollowingToolbar(
    anchor,
    {
      onFilterModeChange: (mode) => {
        if (busy) return;
        filterMode = mode;
        applyFullPageState();
      },
      onSelectAll: () => {
        if (busy) return;
        setAllVisibleChecked(true);
        refreshSelectionFromInputs();
        updateToolbar(true);
      },
      onClearSelection: () => {
        if (busy) return;
        selectedHandles.clear();
        setAllVisibleChecked(false);
        updateToolbar(true);
      },
      onUnfollowSelected: () => {
        void handleUnfollowSelected();
      },
    },
    buildToolbarState(),
  );
  lastToolbarSignature = toolbarSignature(buildToolbarState());
};

const handleUnfollowSelected = async (): Promise<void> => {
  if (busy) return;

  refreshSelectionFromInputs();
  const cells = listVisibleUserCells().filter((cell) => {
    const input = cell.querySelector<HTMLInputElement>(`[${CHECKBOX_INPUT_ATTR}]`);
    return input?.checked === true;
  });

  if (cells.length === 0) {
    statusText = "请先勾选要取消关注的用户";
    updateToolbar(true);
    return;
  }

  const confirmed = window.confirm(
    `确定要取消关注已选的 ${cells.length} 个账号吗？此操作不可撤销。`,
  );
  if (!confirmed) return;

  listObserver?.disconnect();
  listObserver = null;
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
  setAllVisibleChecked(false);
  busy = false;
  statusText = `完成：成功 ${result.succeeded}，失败 ${result.failed}`;
  runPageActivation();
};

const runPageActivation = (): void => {
  if (!isOwnFollowingListPage(location.pathname, readLoggedInUsername())) {
    destroyPageState();
    return;
  }
  ensureToolbar();
  const listRoot = document.querySelector<HTMLElement>(LIST_OBSERVER_SELECTOR);
  if (listRoot !== null) ensureListObserver(listRoot);
  applyFullPageState();
};

let pendingMutations: MutationRecord[] = [];

const scheduleSilentRefresh = (mutations: MutationRecord[]): void => {
  pendingMutations.push(...mutations);
  if (refreshTimer !== 0) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    const batch = pendingMutations;
    pendingMutations = [];
    if (refreshRaf !== 0) cancelAnimationFrame(refreshRaf);
    refreshRaf = requestAnimationFrame(() => {
      refreshRaf = 0;
      if (!isOwnFollowingListPage(location.pathname, readLoggedInUsername())) {
        destroyPageState();
        return;
      }
      silentRefreshNewCells(batch);
    });
  }, REFRESH_DEBOUNCE_MS);
};

const schedulePageActivation = (): void => {
  if (refreshTimer !== 0) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    runPageActivation();
  }, REFRESH_DEBOUNCE_MS);
};

const patchHistoryNavigation = (): void => {
  const notifyRouteChange = (): void => {
    destroyPageState();
    schedulePageActivation();
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      notifyRouteChange();
      return result;
    };
  }
  window.addEventListener("popstate", notifyRouteChange);
};

patchHistoryNavigation();
schedulePageActivation();
