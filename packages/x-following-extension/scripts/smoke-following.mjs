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
const followingUrl = "https://x.com/martin/following";

const mockHtml = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>following</title></head>
<body style="margin:0;background:#000;color:#fff;font-family:system-ui">
  <a data-testid="AppTabBar_Profile_Link" href="/martin" style="display:none"></a>
  <div data-testid="primaryColumn" style="max-width:600px;margin:0 auto">
    <div id="timeline">
      <div id="stickyHeader" style="position:sticky;top:53px">
        <nav>
          <div role="tablist" data-testid="ScrollSnap-List" style="display:flex;gap:16px;padding:12px 16px;border-bottom:1px solid #333">
            <a role="tab" href="/martin/followers">粉丝</a>
            <a role="tab" href="/martin/following" aria-selected="true">正在关注</a>
          </div>
        </nav>
      </div>
      <div id="divider" style="height:0"></div>
      <section role="region" id="list">
        <div data-testid="UserCell" style="position:relative;min-height:72px;padding:12px 16px;border-bottom:1px solid #222">
          <a href="/oneuser">@oneuser</a>
        </div>
        <div data-testid="UserCell" style="position:relative;min-height:72px;padding:12px 16px;border-bottom:1px solid #222">
          <a href="/twouser">@twouser</a>
          <div data-testid="userFollowIndicator">关注了你</div>
        </div>
        <div data-testid="UserCell" style="position:relative;min-height:72px;padding:12px 16px;border-bottom:1px solid #222">
          <a href="/threeuser">@threeuser</a>
        </div>
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

  const metrics = await page.waitForFunction(
    () => {
      const toolbar = !!document.querySelector("[data-xfm-following-toolbar-host]");
      const checkboxes = document.querySelectorAll("[data-xfm-follow-select-input]").length;
      return toolbar && checkboxes >= 2 ? { toolbar, checkboxes } : null;
    },
    null,
    { timeout: 20_000 },
  );

  const result = await metrics.jsonValue();
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
    };
  });

  const ok =
    result.toolbar &&
    detail.toolbarAfterDivider &&
    detail.toolbarBeforeSection &&
    result.checkboxes >= 2 &&
    detail.hiddenByCss >= 1;

  if (!ok) {
    console.error("xfm-smoke: FAIL", { ...result, ...detail });
    process.exit(1);
  }

  console.log("xfm-smoke: OK", { ...result, ...detail });
} finally {
  await context.close();
}
