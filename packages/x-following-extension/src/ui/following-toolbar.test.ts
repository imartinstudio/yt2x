import { describe, expect, it, afterEach } from "vitest";
import {
  findFollowingInsertAnchor,
  findFollowingListInsertPoint,
  findFollowingTablist,
  findTabStickyStrip,
  listFollowingToolbarHosts,
  removeAllFollowingToolbarHosts,
  TOOLBAR_HOST_ATTR,
} from "./following-toolbar.js";

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
