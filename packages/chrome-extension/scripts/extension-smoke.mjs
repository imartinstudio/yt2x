/**
 * Smoke test: load unpacked yt2x extension and verify MAIN world draft writer injection.
 */
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const profileDir = await mkdtemp(join(tmpdir(), "yt2x-ext-smoke-"));

const context = await chromium.launchPersistentContext(profileDir, {
  // MV3 extensions are unreliable in headless Chromium.
  headless: false,
  timeout: 60_000,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

const fail = async (message) => {
  console.error(`extension-smoke: FAIL — ${message}`);
  await context.close();
  process.exit(1);
};

const waitForServiceWorker = async () => {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { timeout: 30_000 });
};

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });

  const serviceWorker = await waitForServiceWorker();
  await page.goto("https://x.com/compose/articles", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(3_000);

  const injectResult = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) return { ok: false, error: "No active tab" };
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["main-world/draft-writer.js"],
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  if (!injectResult.ok) {
    await fail(`MAIN world script injection failed: ${injectResult.error}`);
  }

  const mainWorldReady = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 4_000);
      const listener = (event) => {
        if (event.source !== window) return;
        if (event.data?.source === "yt2x-main" && event.data?.kind === "ready") {
          window.clearTimeout(timeout);
          window.removeEventListener("message", listener);
          resolve(true);
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ source: "yt2x-content", kind: "ready?" }, "*");
    });
  });

  if (!mainWorldReady) {
    await fail("MAIN world draft writer did not respond to ready ping");
  }

  const url = page.url();
  const importButtonCount = await page
    .locator("#yt2x-import-markdown-icon-btn, #yt2x-import-markdown-text-btn")
    .count();
  if (importButtonCount === 0) {
    if (!/compose\/articles/iu.test(url)) {
      console.warn(
        `extension-smoke: PARTIAL — MAIN world OK, but import UI not checked (current URL: ${url}). Log into X Premium and open compose/articles for full UI smoke.`,
      );
      process.exit(0);
    }
    await fail("yt2x import button was not mounted on the X Articles editor");
  }

  console.log("extension-smoke: OK");
} catch (error) {
  await fail(error instanceof Error ? error.message : String(error));
} finally {
  await context.close();
}
