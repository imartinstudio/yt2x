import { describe, expect, it } from "vitest";
import {
  applyFollowingListFilter,
  extractUserCellHandle,
  followingListUsername,
  getSelectedHandles,
  isFollowingListPage,
  isOwnFollowingListPage,
  setAllVisibleChecked,
  shouldShowOneWayFollowCell,
  shouldShowUserCell,
  userCellFollowsYou,
} from "./following-filter.js";

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
    expect(isOwnFollowingListPage("/martin/following", "martin")).toBe(true);
    expect(isOwnFollowingListPage("/other/following", "martin")).toBe(false);
    expect(isOwnFollowingListPage("/martin/followers", "martin")).toBe(false);
  });
});

describe("shouldShowOneWayFollowCell", () => {
  it("shows only users who do not follow back", () => {
    expect(shouldShowOneWayFollowCell(buildUserCell(false))).toBe(true);
    expect(shouldShowOneWayFollowCell(buildUserCell(true))).toBe(false);
  });
});

describe("shouldShowUserCell", () => {
  it("shows every row in all mode", () => {
    expect(shouldShowUserCell(buildUserCell(true), "all")).toBe(true);
    expect(shouldShowUserCell(buildUserCell(false), "all")).toBe(true);
  });
});

describe("applyFollowingListFilter", () => {
  it("hides mutual follows only in one-way mode", () => {
    const root = document.createElement("div");
    const mutual = buildUserCell(true, "mutual");
    const oneWay = buildUserCell(false, "oneway");
    root.append(mutual, oneWay);
    document.body.append(root);

    applyFollowingListFilter("one-way", root);
    expect(mutual.getAttribute("data-xfm-follow-filter")).toBe("hidden");
    expect(oneWay.getAttribute("data-xfm-follow-filter")).toBe("shown");

    applyFollowingListFilter("all", root);
    expect(mutual.getAttribute("data-xfm-follow-filter")).toBeNull();
    expect(oneWay.getAttribute("data-xfm-follow-filter")).toBeNull();

    root.remove();
  });
});

describe("extractUserCellHandle", () => {
  it("reads profile handle from user link", () => {
    expect(extractUserCellHandle(buildUserCell(false, "Bob"))).toBe("bob");
  });
});

describe("selection helpers", () => {
  it("tracks checked visible users", () => {
    const root = document.createElement("div");
    const cell = buildUserCell(false, "pickme");
    root.append(cell);
    document.body.append(root);

    applyFollowingListFilter("all", root);
    setAllVisibleChecked(true, root);
    expect(getSelectedHandles(root)).toEqual(["pickme"]);

    root.remove();
  });
});
