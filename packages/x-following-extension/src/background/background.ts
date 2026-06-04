const FOLLOWING_PATH = /\/following\/?$/u;

const isXUrl = (url: string | undefined): boolean =>
  url !== undefined && (url.includes("x.com") || url.includes("twitter.com"));

const isFollowingUrl = (url: string): boolean => {
  try {
    return FOLLOWING_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
};

const ensureContentScript = async (tabId: number): Promise<void> => {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        marker: document.documentElement?.getAttribute("data-xfm-extension") ?? null,
        toolbar: document.querySelector("[data-xfm-following-toolbar-host]") !== null,
        checkboxes: document.querySelectorAll("[data-xfm-follow-select-input]").length,
      }),
    });
    const state = probe?.result as
      | { marker?: string | null; toolbar?: boolean; checkboxes?: number }
      | undefined;
    if (state?.toolbar === true) return;

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/following-manager.js"],
    });
  } catch {
    // chrome://、未授权站点等
  }
};

const injectOpenXFollowingTabs = async (): Promise<void> => {
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  for (const tab of tabs) {
    if (tab.id === undefined || tab.url === undefined) continue;
    if (!isFollowingUrl(tab.url)) continue;
    await ensureContentScript(tab.id);
  }
};

chrome.runtime.onInstalled.addListener(() => {
  void injectOpenXFollowingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectOpenXFollowingTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || tab.url === undefined) return;
  if (!isXUrl(tab.url) || !isFollowingUrl(tab.url)) return;
  void ensureContentScript(tabId);
});
