/**
 * Load x-following-extension on mocked x.com/following and verify UI injection.
 * MV3 content scripts are unreliable in headless Chromium — use headed Playwright Chromium.
 */
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const profileDir = await mkdtemp(join(tmpdir(), "xfm-smoke-"));
const followingUrl = "https://x.com/php_martin/following";

const totalUsers = 839;
const oneWayUsers = 156;
const mockUserCells = Array.from({ length: totalUsers }, (_, index) => {
  const userNumber = index + 1;
  const followsYou = userNumber > oneWayUsers;
  return `
        <div data-testid="UserCell" style="position:relative;min-height:72px;padding:12px 16px;border-bottom:1px solid #222">
          <a href="/mock_user_${userNumber}">@mock_user_${userNumber}</a>
          ${followsYou ? '<div data-testid="userFollowIndicator">关注了你</div>' : ""}
        </div>`;
}).join("");

const mockHtml = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>following</title></head>
<body style="margin:0;background:#000;color:#fff;font-family:system-ui">
  <a data-testid="AppTabBar_Profile_Link" href="/php_martin" style="display:none"></a>
  <div data-testid="primaryColumn" style="max-width:600px;margin:0 auto">
    <div id="timeline">
      <div id="stickyHeader" style="position:sticky;top:53px">
        <nav>
          <div role="tablist" data-testid="ScrollSnap-List" style="display:flex;gap:16px;padding:12px 16px;border-bottom:1px solid #333">
            <a role="tab" href="/php_martin/followers">粉丝</a>
            <a role="tab" href="/php_martin/following" aria-selected="true">正在关注</a>
          </div>
        </nav>
      </div>
      <div id="divider" style="height:0"></div>
      <section role="region" id="list">
        ${mockUserCells}
      </section>
    </div>
  </div>
</body></html>`;

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  timeout: 60_000,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.route(followingUrl, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: mockHtml });
  });
  await page.goto(followingUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });

  const metrics = await page
    .waitForFunction(
      () => {
        const toolbar = !!document.querySelector("[data-xfm-following-toolbar-host]");
        const checkboxes = document.querySelectorAll("[data-xfm-follow-select-input]").length;
        return toolbar && checkboxes >= 2 ? { toolbar, checkboxes } : null;
      },
      null,
      { timeout: 20_000 },
    )
    .catch(async (error) => {
      const diagnostics = await page.evaluate(() => ({
        url: location.href,
        path: location.pathname,
        marker: document.documentElement.getAttribute("data-xfm-extension"),
        status: window.__xfmStatus?.() ?? null,
        primaryColumn: document.querySelector('[data-testid="primaryColumn"]') !== null,
        selectedTab:
          document.querySelector('a[aria-selected="true"]')?.getAttribute("href") ?? null,
        profileLink:
          document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute("href") ??
          null,
        cells: document.querySelectorAll('[data-testid="UserCell"]').length,
        toolbar: document.querySelector("[data-xfm-following-toolbar-host]") !== null,
        checkboxes: document.querySelectorAll("[data-xfm-follow-select-input]").length,
      }));
      console.error("xfm-smoke: TIMEOUT", diagnostics);
      throw error;
    });

  const result = await metrics.jsonValue();

  const countsAfterRoundTrip = await page.evaluate(async () => {
    const toolbar = document.querySelector("[data-xfm-following-toolbar-host]");
    if (!(toolbar instanceof HTMLElement) || toolbar.shadowRoot === null) {
      throw new Error("toolbar not mounted");
    }
    const shadow = toolbar.shadowRoot;
    const click = (selector) => {
      const button = shadow.querySelector(selector);
      if (!(button instanceof HTMLButtonElement)) throw new Error(`missing button ${selector}`);
      button.click();
    };
    const readCounts = () => ({
      loaded: shadow.querySelector('[data-ref="loaded-count"]')?.textContent?.trim(),
      selected: shadow.querySelector('[data-ref="selected-count"]')?.textContent?.trim(),
      oneWay: shadow.querySelector('[data-ref="oneway-count"]')?.textContent?.trim(),
    });
    const waitForCounts = async (expected) => {
      for (let i = 0; i < 40; i += 1) {
        const counts = readCounts();
        if (
          counts.loaded === expected.loaded &&
          counts.selected === expected.selected &&
          counts.oneWay === expected.oneWay
        ) {
          return counts;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return readCounts();
    };

    click('[data-action="filter-all"]');
    await waitForCounts({ loaded: "839", selected: "0", oneWay: "156" });
    click('[data-action="select-all"]');
    await waitForCounts({ loaded: "839", selected: "839", oneWay: "156" });
    click('[data-action="filter-one-way"]');
    return waitForCounts({ loaded: "156", selected: "0", oneWay: "156" });
  });

  const detail = await page.evaluate(() => {
    const toolbar = document.querySelector("[data-xfm-following-toolbar-host]");
    const divider = document.getElementById("divider");
    const section = document.querySelector("section[role='region']");
    return {
      toolbarAfterDivider: divider?.nextElementSibling === toolbar,
      toolbarBeforeSection: section?.previousElementSibling === toolbar,
      hiddenByCss: [...document.querySelectorAll('[data-testid="UserCell"]')].filter(
        (el) => getComputedStyle(el).display === "none",
      ).length,
      cells: document.querySelectorAll('[data-testid="UserCell"]').length,
      visibleCells: [...document.querySelectorAll('[data-testid="UserCell"]')].filter(
        (el) => getComputedStyle(el).display !== "none",
      ).length,
    };
  });

  const ok =
    result.toolbar &&
    detail.toolbarAfterDivider &&
    detail.toolbarBeforeSection &&
    result.checkboxes >= 2 &&
    detail.hiddenByCss === totalUsers - oneWayUsers &&
    detail.visibleCells === oneWayUsers &&
    countsAfterRoundTrip.loaded === String(oneWayUsers) &&
    countsAfterRoundTrip.selected === "0" &&
    countsAfterRoundTrip.oneWay === String(oneWayUsers);

  if (!ok) {
    console.error("xfm-smoke: FAIL", { ...result, ...detail, countsAfterRoundTrip });
    process.exit(1);
  }

  console.log("xfm-smoke: OK", { ...result, ...detail, countsAfterRoundTrip });
} finally {
  await context.close();
}
