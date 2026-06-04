import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findFollowingInsertAnchor,
  findFollowingListInsertPoint,
  findFollowingTablist,
  findTabStickyStrip,
  listFollowingToolbarHosts,
  mountFollowingToolbar,
  removeAllFollowingToolbarHosts,
  TOOLBAR_HOST_ATTR,
} from "./following-toolbar.js";
import type { FollowingToolbarState, FollowingToolbarHandlers } from "./following-toolbar.js";

const resetDom = (): void => {
  document.body.innerHTML = "";
};

afterEach(() => {
  resetDom();
});

describe("findFollowingListInsertPoint", () => {
  it("inserts after sticky tab strip and before list section (X layout)", () => {
    document.body.innerHTML = `
      <div data-testid="primaryColumn">
        <div id="timeline">
          <div id="stickyHeader" style="position:sticky;top:53px;height:107px">
            <nav>
              <div role="tablist" data-testid="ScrollSnap-List" id="tabs">
                <a role="tab" href="/u/following" aria-selected="true">正在关注</a>
              </div>
            </nav>
          </div>
          <div id="divider" style="height:0"></div>
          <section role="region">
            <button data-testid="UserCell"><a href="/alice">@alice</a></button>
          </section>
        </div>
      </div>
    `;

    const tablist = findFollowingTablist();
    expect(tablist?.getAttribute("data-testid")).toBe("ScrollSnap-List");
    expect(findTabStickyStrip(tablist!).id).toBe("stickyHeader");
    expect(findFollowingInsertAnchor(tablist!).id).toBe("divider");

    const point = findFollowingListInsertPoint();
    expect(point).not.toBeNull();

    const host = document.createElement("div");
    host.setAttribute(TOOLBAR_HOST_ATTR, "true");
    const parent = point!.after.parentElement!;
    parent.insertBefore(host, point!.after.nextElementSibling);

    const timeline = document.getElementById("timeline");
    const childIds = [...(timeline?.children ?? [])].map((el) => {
      if (el.hasAttribute(TOOLBAR_HOST_ATTR)) return "toolbar";
      return el.id || el.getAttribute("data-testid") || el.getAttribute("role");
    });
    expect(childIds).toEqual(["stickyHeader", "divider", "toolbar", "region"]);
  });
});

describe("toolbar host dedupe", () => {
  it("removes all toolbar host nodes", () => {
    document.body.innerHTML = "";
    for (let i = 0; i < 2; i += 1) {
      const host = document.createElement("div");
      host.setAttribute(TOOLBAR_HOST_ATTR, "true");
      document.body.append(host);
    }
    expect(listFollowingToolbarHosts()).toHaveLength(2);
    removeAllFollowingToolbarHosts();
    expect(listFollowingToolbarHosts()).toHaveLength(0);
  });
});

describe("mountFollowingToolbar", () => {
  const initialState: FollowingToolbarState = {
    filterMode: "one-way",
    loadedCount: 20,
    selectedCount: 3,
    busy: false,
    statusText: "就绪",
    phase: "normal",
    oneWayCount: 14,
  };

  const noopHandlers: FollowingToolbarHandlers = {
    onFilterModeChange: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    onUnfollowSelected: vi.fn(),
  };

  afterEach(() => {
    removeAllFollowingToolbarHosts();
  });

  it("renders toolbar with glass-morphism styles and correct stats", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("20");
    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("3");
    expect(shadow.querySelector('[data-ref="oneway-count"]')?.textContent).toBe("14");
    expect(shadow.querySelector(".title")?.textContent).toContain("X 清道夫");

    const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
    expect(filterOneWay.classList.contains("active")).toBe(true);

    tb.remove();
  });

  it("updates stats and filter button when paint is called", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({ ...initialState, selectedCount: 8, loadedCount: 25, filterMode: "all", oneWayCount: 5 });

    expect(shadow.querySelector('[data-ref="selected-count"]')?.textContent).toBe("8");
    expect(shadow.querySelector('[data-ref="loaded-count"]')?.textContent).toBe("25");

    const filterOneWay = shadow.querySelector<HTMLButtonElement>('[data-action="filter-one-way"]')!;
    const filterAll = shadow.querySelector<HTMLButtonElement>('[data-action="filter-all"]')!;
    expect(filterOneWay.classList.contains("active")).toBe(false);
    expect(filterAll.classList.contains("active")).toBe(true);

    tb.remove();
  });

  it("shows progress bar when phase is progress", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: true,
      phase: "progress",
      progress: {
        done: 2,
        total: 5,
        recentLog: [
          { handle: "alice", succeeded: true },
          { handle: "bob", succeeded: true },
        ],
      },
    });

    const pw = shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')!;
    expect(pw.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="progress-fill"]')?.getAttribute("style")).toContain("40%");
    expect(shadow.querySelector('[data-ref="progress-count"]')?.textContent).toBe("2 / 5");
    expect(shadow.querySelector('[data-ref="progress-log"]')?.textContent).toContain("alice");

    tb.remove();
  });

  it("shows complete banner when phase is complete", () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    tb.update({
      ...initialState,
      busy: false,
      phase: "complete",
      completeResult: { succeeded: 5, failed: 0 },
    });

    const cw = shadow.querySelector<HTMLElement>('[data-ref="complete-wrap"]')!;
    expect(cw.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="complete-text"]')?.textContent).toContain("5");
    expect(shadow.querySelector<HTMLElement>('[data-ref="progress-wrap"]')?.classList.contains("show")).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow shows dialog and resolves true on confirm click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(6, 6);
    const overlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
    expect(overlay.classList.contains("show")).toBe(true);
    expect(shadow.querySelector('[data-ref="dialog-desc"]')?.innerHTML).toContain("6");

    shadow.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')!.click();

    const result = await promise;
    expect(result).toBe(true);
    expect(overlay.classList.contains("show")).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow resolves false on cancel click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(3, 3);
    shadow.querySelector<HTMLButtonElement>('[data-action="dialog-cancel"]')!.click();

    const result = await promise;
    expect(result).toBe(false);

    tb.remove();
  });

  it("confirmUnfollow resolves false on overlay click", async () => {
    const tb = mountFollowingToolbar(null, document.body, noopHandlers, initialState);
    const shadow = tb.root.shadowRoot!;

    const promise = tb.confirmUnfollow(2, 2);
    const overlay = shadow.querySelector<HTMLElement>('[data-ref="dialog-overlay"]')!;
    overlay.click();

    const result = await promise;
    expect(result).toBe(false);

    tb.remove();
  });
});
