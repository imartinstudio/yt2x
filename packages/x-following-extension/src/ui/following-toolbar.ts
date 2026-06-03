import type { FollowingFilterMode } from "../dom/following-filter.js";

export type FollowingToolbarState = {
  filterMode: FollowingFilterMode;
  visibleCount: number;
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

const toolbarSignature = (state: FollowingToolbarState): string =>
  `${state.filterMode}|${state.visibleCount}|${state.selectedCount}|${state.busy}|${state.statusText}`;

export const mountFollowingToolbar = (
  anchor: HTMLElement,
  handlers: FollowingToolbarHandlers,
  initialState: FollowingToolbarState,
): FollowingToolbar => {
  const host = document.createElement("div");
  host.setAttribute("data-xfm-following-toolbar-host", "true");
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .bar {
        box-sizing: border-box;
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid rgb(47, 51, 54);
        background: rgba(0, 0, 0, 0.92);
        backdrop-filter: blur(12px);
        color: rgb(231, 233, 234);
      }
      .title {
        font-size: 15px;
        font-weight: 700;
      }
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
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      button.primary {
        border-color: rgb(244, 33, 46);
        color: rgb(244, 33, 46);
      }
      button.primary:not(:disabled):hover {
        background: rgba(244, 33, 46, 0.12);
      }
      .meta {
        font-size: 13px;
        color: rgb(113, 118, 123);
      }
      .status {
        font-size: 13px;
        color: rgb(113, 118, 123);
        min-height: 18px;
      }
    </style>
    <div class="bar" data-xfm-following-toolbar="true">
      <div class="title">关注列表助手</div>
      <div class="filters">
        <span>筛选：</span>
        <label><input type="radio" name="xfm-filter" value="one-way" /> 仅未回关</label>
        <label><input type="radio" name="xfm-filter" value="all" /> 全部</label>
        <span class="meta" data-ref="meta"></span>
      </div>
      <div class="actions">
        <button type="button" data-action="select-all">全选可见</button>
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
  shadow.querySelector("[data-action='select-all']")?.addEventListener("click", () => {
    handlers.onSelectAll();
  });
  shadow.querySelector("[data-action='clear-selection']")?.addEventListener("click", () => {
    handlers.onClearSelection();
  });
  shadow.querySelector("[data-action='unfollow-selected']")?.addEventListener("click", () => {
    handlers.onUnfollowSelected();
  });

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
      metaEl.textContent = `当前可见 ${state.visibleCount} 人 · 已选 ${state.selectedCount} 人`;
    }
    if (statusEl !== null) {
      statusEl.textContent = state.statusText;
    }
  };

  paint(initialState);
  anchor.prepend(host);

  return {
    root: host,
    update: paint,
    remove: () => {
      host.remove();
    },
  };
};

export const findFollowingToolbarAnchor = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="primaryColumn"]') ??
  document.querySelector<HTMLElement>('main[role="main"]');
