import {
  buildMediaRegistry,
  pickMarkdownFile,
  pickMediaDirectory,
  pickSupplementalMedia,
  readFileAsText,
} from "../files/local-media.js";
import { prepareArticleImport } from "../files/prepare-import.js";
import { dismissOpenOverlays, writeArticleDraftToPage } from "../dom/x-editor-adapter.js";
import { createNewArticleDraft, findImportButtonAnchor } from "../dom/locators.js";
import {
  buildImportPreviewState,
  loadSubscriptionTier,
  showImportError,
  showImportPreviewDialog,
  showImportSuccessToast,
} from "../ui/import-dialog.js";
import {
  extensionInvalidatedUserMessage,
  isExtensionRuntimeAlive,
  toUserFacingImportError,
} from "../runtime/extension-runtime.js";
import {
  IMPORT_BUTTON_ID,
  type ImportLoadingHandle,
  showImportLoading,
} from "../ui/import-loading.js";

const BUTTON_ID = IMPORT_BUTTON_ID;
const MOUNT_ATTR = "data-yt2x-import-mounted";

const mountImportButton = (): void => {
  const anchor = findImportButtonAnchor();
  const existing = document.getElementById(BUTTON_ID);
  if (anchor === null) {
    existing?.remove();
    return;
  }
  if (existing !== null && existing.previousElementSibling === anchor) return;
  existing?.remove();

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "导入 Markdown";
  button.setAttribute("aria-label", "新建 X Articles 草稿并导入 Markdown");
  button.style.cssText =
    "margin-inline:6px;padding:4px 10px;border-radius:999px;border:1px solid #cfd9de;background:#fff;color:#0f1419;font:13px system-ui,sans-serif;cursor:pointer;vertical-align:middle";
  if (!isExtensionRuntimeAlive()) {
    button.disabled = true;
    button.title = extensionInvalidatedUserMessage;
    button.textContent = "请刷新页面后导入";
  } else {
    button.addEventListener("click", () => {
      void handleImportClick();
    });
  }
  anchor.insertAdjacentElement("afterend", button);
  document.documentElement.setAttribute(MOUNT_ATTR, "true");
};

const handleImportClick = async (): Promise<void> => {
  if (!isExtensionRuntimeAlive()) {
    showImportError(extensionInvalidatedUserMessage);
    return;
  }

  try {
    const markdownFile = await pickMarkdownFile();
    if (markdownFile === null) return;

    const markdown = await readFileAsText(markdownFile);
    let authorizedFiles = [markdownFile];
    let registry = buildMediaRegistry({ markdown, authorizedFiles });
    let subscriptionTier = await loadSubscriptionTier();
    let confirmedTier = subscriptionTier;

    while (true) {
      subscriptionTier = await loadSubscriptionTier();
      const preview = buildImportPreviewState({ markdown, subscriptionTier, mediaRegistry: registry });
      const dialog = await showImportPreviewDialog(preview);

      if (dialog.type === "cancel") return;

      if (dialog.type === "pick-directory") {
        const directoryFiles = await pickMediaDirectory();
        if (directoryFiles.length > 0) {
          authorizedFiles = [...authorizedFiles, ...directoryFiles];
          registry = buildMediaRegistry({ markdown, authorizedFiles });
        }
        continue;
      }

      if (dialog.type === "pick-files") {
        const supplemental = await pickSupplementalMedia();
        if (supplemental.length > 0) {
          authorizedFiles = [...authorizedFiles, ...supplemental];
          registry = buildMediaRegistry({ markdown, authorizedFiles });
        }
        continue;
      }

      confirmedTier = dialog.subscriptionTier;
      break;
    }

    let loading: ImportLoadingHandle | null = showImportLoading("正在新建草稿…");
    try {
      loading.update("正在新建草稿…");
      await createNewArticleDraft();

      loading.update("正在准备导入数据（表格/Mermaid 等）…");
      const confirmedPrepared = await prepareArticleImport({
        markdown,
        subscriptionTier: confirmedTier,
        mediaRegistry: registry,
      });

      const result = await writeArticleDraftToPage(confirmedPrepared, {
        onProgress: (message) => loading?.update(message),
      });
      loading.close();
      loading = null;
      showImportSuccessToast({
        skippedDividers: result.skippedDividers,
        skippedPromptCodeBlocks: result.skippedPromptCodeBlocks,
        skippedMedia: result.skippedMedia,
        lastMediaError: result.lastMediaError,
        manualContentMedia: result.manualContentMedia,
      });
    } finally {
      loading?.close();
    }
  } catch (err: unknown) {
    dismissOpenOverlays();
    showImportError(toUserFacingImportError(err));
  }
};

const observer = new MutationObserver(() => {
  mountImportButton();
});

observer.observe(document.documentElement, { childList: true, subtree: true });
mountImportButton();
