const STORAGE_KEY = "yt2x.articleImport.subscriptionTier";
const FALLBACK_PREFIX = "yt2x:";

export type XArticleSubscriptionTier = "premium" | "premium-plus";

export const isExtensionContextInvalidated = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /extension context invalidated/i.test(message);
};

export const isExtensionRuntimeAlive = (): boolean => {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

const readTierFromLocalStorage = (): XArticleSubscriptionTier => {
  const value = localStorage.getItem(`${FALLBACK_PREFIX}${STORAGE_KEY}`);
  return value === "premium-plus" ? "premium-plus" : "premium";
};

const writeTierToLocalStorage = (tier: XArticleSubscriptionTier): void => {
  localStorage.setItem(`${FALLBACK_PREFIX}${STORAGE_KEY}`, tier);
};

export const loadSubscriptionTier = async (): Promise<XArticleSubscriptionTier> => {
  if (!isExtensionRuntimeAlive()) {
    return readTierFromLocalStorage();
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    const tier: XArticleSubscriptionTier = value === "premium-plus" ? "premium-plus" : "premium";
    writeTierToLocalStorage(tier);
    return tier;
  } catch (error: unknown) {
    if (isExtensionContextInvalidated(error)) {
      return readTierFromLocalStorage();
    }
    throw error;
  }
};

export const saveSubscriptionTier = async (tier: XArticleSubscriptionTier): Promise<void> => {
  writeTierToLocalStorage(tier);
  if (!isExtensionRuntimeAlive()) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: tier });
  } catch (error: unknown) {
    if (isExtensionContextInvalidated(error)) return;
    throw error;
  }
};

export const extensionInvalidatedUserMessage =
  "yt2x 扩展已重新加载，当前页面上的脚本已失效。请刷新此 X Articles 页面后，再点击「导入 Markdown」。";

export const toUserFacingImportError = (error: unknown): string => {
  if (isExtensionContextInvalidated(error)) return extensionInvalidatedUserMessage;
  return error instanceof Error ? error.message : String(error);
};
