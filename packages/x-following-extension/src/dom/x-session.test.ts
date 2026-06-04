import { describe, expect, it } from "vitest";
import {
  collectProfileUserKeys,
  followingPageUserKey,
  isFollowingListPage,
  isOwnFollowingListPage,
  profilePathToUserKey,
} from "./x-session.js";

describe("profilePathToUserKey", () => {
  it("reads handle and numeric profile paths", () => {
    expect(profilePathToUserKey("/Martin")).toBe("martin");
    expect(profilePathToUserKey("/i/user/44196397")).toBe("id:44196397");
  });
});

describe("followingPageUserKey", () => {
  it("supports handle and /i/user following routes", () => {
    expect(followingPageUserKey("/martin/following")).toBe("martin");
    expect(followingPageUserKey("/i/user/44196397/following")).toBe("id:44196397");
  });
});

describe("isOwnFollowingListPage", () => {
  it("matches own following tab for handle and id routes", () => {
    document.body.innerHTML = '<a role="tab" href="/martin/following" aria-selected="true">正在关注</a>';
    expect(isOwnFollowingListPage("/martin/following", "martin")).toBe(true);
    document.body.innerHTML = '<a role="tab" href="/i/user/99/following" aria-selected="true">正在关注</a>';
    expect(isOwnFollowingListPage("/i/user/99/following", "id:99")).toBe(true);
    document.body.innerHTML = "";
    expect(isOwnFollowingListPage("/other/following", "martin")).toBe(false);
  });

  it("falls back to following tab href when profile links are not ready", () => {
    document.body.innerHTML = `
      <div data-testid="primaryColumn">
        <a href="/php_martin/following" aria-selected="true">正在关注</a>
      </div>
    `;
    expect(isOwnFollowingListPage("/php_martin/following", null, document)).toBe(true);
    document.body.innerHTML = "";
  });

  it("matches when DOM profile links include the page handle", () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/php_martin"></a>
      <a role="tab" href="/php_martin/following" aria-selected="true">正在关注</a>
    `;
    expect(isOwnFollowingListPage("/php_martin/following", null, document)).toBe(true);
    expect(isOwnFollowingListPage("/martin/following", null, document)).toBe(false);
    document.body.innerHTML = "";
  });

  it("rejects non-following routes", () => {
    expect(isFollowingListPage("/martin/followers")).toBe(false);
  });
});

describe("collectProfileUserKeys", () => {
  it("collects multiple profile link keys", () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/php_martin"></a>
      <a data-testid="SideNav_AccountSwitcher_Button" href="/php_martin"></a>
    `;
    expect(collectProfileUserKeys(document)).toEqual(["php_martin"]);
    document.body.innerHTML = "";
  });
});
