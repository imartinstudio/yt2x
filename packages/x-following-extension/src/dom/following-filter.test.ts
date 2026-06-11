import { describe, expect, it } from "vitest";
import {
  extractUserCellHandle,
  followingListUsername,
  isOwnFollowingListPage,
  setFollowingFilterMode,
  shouldShowCheckboxOnCell,
  shouldShowOneWayFollowCell,
  userCellFollowsYou,
} from "./following-filter.js";
import { isFollowingListPage } from "./x-session.js";

const buildUserCell = (followsYou: boolean, handle = "alice"): HTMLElement => {
  const cell = document.createElement("div");
  cell.setAttribute("data-testid", "UserCell");
  const link = document.createElement("a");
  link.href = `/${handle}`;
  cell.append(link);
  if (followsYou) {
    const indicator = document.createElement("div");
    indicator.setAttribute("data-testid", "userFollowIndicator");
    cell.append(indicator);
  }
  return cell;
};

describe("isFollowingListPage", () => {
  it("matches profile following tabs", () => {
    expect(isFollowingListPage("/martin/following")).toBe(true);
    expect(isFollowingListPage("/martin/following/")).toBe(true);
  });

  it("does not match followers or other routes", () => {
    expect(isFollowingListPage("/martin/followers")).toBe(false);
    expect(isFollowingListPage("/compose/articles/edit")).toBe(false);
  });
});

describe("userCellFollowsYou", () => {
  it("detects follow-back via data-testid", () => {
    expect(userCellFollowsYou(buildUserCell(true))).toBe(true);
    expect(userCellFollowsYou(buildUserCell(false))).toBe(false);
  });

  it("detects follow-back via localized label text", () => {
    const cell = buildUserCell(false);
    const label = document.createElement("span");
    label.textContent = "关注了你";
    cell.append(label);
    expect(userCellFollowsYou(cell)).toBe(true);
  });
});

describe("followingListUsername", () => {
  it("extracts profile handle from path", () => {
    expect(followingListUsername("/Martin/following")).toBe("martin");
  });
});

describe("isOwnFollowingListPage", () => {
  it("matches only the signed-in user's following tab", () => {
    document.body.innerHTML = '<a role="tab" href="/martin/following" aria-selected="true">正在关注</a>';
    expect(isOwnFollowingListPage("/martin/following", "martin")).toBe(true);
    expect(isOwnFollowingListPage("/other/following", "martin")).toBe(false);
    expect(isOwnFollowingListPage("/martin/followers", "martin")).toBe(false);
    document.body.innerHTML = "";
  });
});

describe("shouldShowOneWayFollowCell", () => {
  it("shows only users who do not follow back", () => {
    expect(shouldShowOneWayFollowCell(buildUserCell(false))).toBe(true);
    expect(shouldShowOneWayFollowCell(buildUserCell(true))).toBe(false);
  });
});

describe("shouldShowCheckboxOnCell", () => {
  it("shows checkbox targets for all mode", () => {
    expect(shouldShowCheckboxOnCell(buildUserCell(true), "all")).toBe(true);
    expect(shouldShowCheckboxOnCell(buildUserCell(false), "all")).toBe(true);
  });
});

describe("setFollowingFilterMode", () => {
  it("uses html attribute and stylesheet without touching user cells", () => {
    const cell = buildUserCell(true, "mutual");
    document.body.append(cell);

    setFollowingFilterMode("one-way");
    expect(document.documentElement.getAttribute("data-xfm-filter")).toBe("one-way");
    expect(cell.getAttribute("data-xfm-follow-filter")).toBeNull();
    expect(document.getElementById("xfm-following-filter-style")?.textContent).toContain(
      ":has(> [data-testid=\"UserCell\"]:only-child:has(",
    );

    setFollowingFilterMode("all");
    expect(document.documentElement.getAttribute("data-xfm-filter")).toBeNull();

    cell.remove();
    document.getElementById("xfm-following-filter-style")?.remove();
    document.documentElement.removeAttribute("data-xfm-filter");
  });

  it("filter CSS does not affect shadow DOM toolbar content", () => {
    const host = document.createElement("div");
    host.setAttribute("data-xfm-following-toolbar-host", "true");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<div class="bar"><span class="title">X 清道夫</span></div>';
    document.body.append(host);

    setFollowingFilterMode("one-way");

    const title = shadow.querySelector(".title");
    expect(title?.textContent).toBe("X 清道夫");
    expect(title instanceof HTMLElement).toBe(true);

    host.remove();
    document.getElementById("xfm-following-filter-style")?.remove();
    document.documentElement.removeAttribute("data-xfm-filter");
  });
});

describe("extractUserCellHandle", () => {
  it("reads profile handle from user link", () => {
    expect(extractUserCellHandle(buildUserCell(false, "Bob"))).toBe("bob");
  });

  it("picks most frequent handle from cell links", () => {
    const cell = buildUserCell(false, "ignored");
    // @PickMe 出现两次（模拟头像+名称），频率高于 ignored 的一次，应该胜出
    const link1 = document.createElement("a");
    link1.href = "/@PickMe";
    cell.append(link1);
    const link2 = document.createElement("a");
    link2.href = "/@PickMe";
    cell.append(link2);
    expect(extractUserCellHandle(cell)).toBe("pickme");
  });
});
