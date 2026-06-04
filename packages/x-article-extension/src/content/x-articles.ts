import {
  buildMediaRegistry,
  pickArticleDirectory,
  pickMediaDirectory,
  pickSupplementalMedia,
  readFileAsText,
} from "../files/local-media.js";
import { prepareArticleImport } from "../files/prepare-import.js";
import { dismissOpenOverlays, writeArticleDraftToPage } from "../dom/x-editor-adapter.js";
import {
  createNewArticleDraft,
  findImportIconButtonAnchor,
  findImportTextButtonAnchor,
  waitForArticleDraftReady,
} from "../dom/locators.js";
import {
  buildImportPreviewState,
  loadSubscriptionTier,
  showImportError,
  showImportPreviewDialog,
  showImportSuccessToast,
  type ImportPreview,
} from "../ui/import-dialog.js";
import {
  extensionInvalidatedUserMessage,
  isExtensionRuntimeAlive,
  toUserFacingImportError,
} from "../runtime/extension-runtime.js";
import {
  IMPORT_BUTTON_IDS,
  type ImportLoadingHandle,
  showImportLoading,
} from "../ui/import-loading.js";
import {
  alignImportIconPair,
  ensureImportTextPair,
  importIconMarkup,
  isImportButtonPlaced,
  styleImportButton,
  type ImportButtonVariant,
} from "../ui/import-button-style.js";

const MOUNT_ATTR = "data-yt2x-import-mounted";
const ARTICLE_PATH_PREFIX = "/compose/articles";

type ImportMode = "new-draft" | "current-draft";

type ImportButtonConfig = {
  id: string;
  variant: ImportButtonVariant;
  mode: ImportMode;
  placement: InsertPosition;
  label: string;
  title: string;
  findAnchor: () => HTMLElement | null;
};

const buttonConfigs: ImportButtonConfig[] = [
  {
    id: IMPORT_BUTTON_IDS.icon,
    variant: "icon",
    mode: "new-draft",
    placement: "beforebegin",
    label: "导入Markdown",
    title: "新建 X Articles 草稿并导入 Markdown",
    findAnchor: findImportIconButtonAnchor,
  },
  {
    id: IMPORT_BUTTON_IDS.text,
    variant: "text",
    mode: "new-draft",
    placement: "afterend",
    label: "导入",
    title: "导入 Markdown 到当前 X Articles 草稿",
    findAnchor: findImportTextButtonAnchor,
  },
];

const isArticleComposePage = (): boolean =>
  location.hostname === "x.com" && location.pathname.startsWith(ARTICLE_PATH_PREFIX);

const removeImportButtons = (): void => {
  for (const config of buttonConfigs) {
    document.getElementById(config.id)?.remove();
  }
  document.documentElement.removeAttribute(MOUNT_ATTR);
};

const mountImportButton = (config: ImportButtonConfig): void => {
  const anchor = config.findAnchor();
  const existing = document.getElementById(config.id);
  if (anchor === null) {
    existing?.remove();
    return;
  }
  if (existing !== null && isImportButtonPlaced(existing, anchor, config.placement)) return;
  existing?.remove();

  const button = document.createElement("button");
  button.id = config.id;
  button.type = "button";
  button.title = config.title;
  button.setAttribute("aria-label", config.title);
  styleImportButton(button, anchor, config.variant);
  if (!isExtensionRuntimeAlive()) {
    button.disabled = true;
    button.title = extensionInvalidatedUserMessage;
    button.textContent = "请刷新页面后导入";
  } else {
    if (config.variant === "icon") {
      button.innerHTML = importIconMarkup;
    } else {
      button.textContent = config.label;
    }
    button.addEventListener("click", () => {
      void handleImportClick(config.mode);
    });
  }
  if (config.variant === "text") {
    ensureImportTextPair(anchor, button);
  } else {
    anchor.insertAdjacentElement(config.placement, button);
    alignImportIconPair(anchor, button);
  }
  document.documentElement.setAttribute(MOUNT_ATTR, "true");
};

const mountImportButtons = (): void => {
  if (!isArticleComposePage()) {
    removeImportButtons();
    return;
  }
  for (const config of buttonConfigs) {
    mountImportButton(config);
  }
};

let mountTimer = 0;

const scheduleMountImportButtons = (): void => {
  if (mountTimer !== 0) return;
  mountTimer = window.setTimeout(() => {
    mountTimer = 0;
    mountImportButtons();
  }, 350);
};

const startMountRetryWindow = (): void => {
  let attempts = 0;
  const retry = window.setInterval(() => {
    attempts += 1;
    scheduleMountImportButtons();
    if (attempts >= 20 || document.documentElement.hasAttribute(MOUNT_ATTR)) {
      window.clearInterval(retry);
    }
  }, 500);
};

const patchHistoryNavigation = (): void => {
  const notifyRouteChange = (): void => {
    scheduleMountImportButtons();
    startMountRetryWindow();
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      notifyRouteChange();
      return result;
    };
  }
  window.addEventListener("popstate", notifyRouteChange);
};

const handleImportClick = async (mode: ImportMode): Promise<void> => {
  if (!isExtensionRuntimeAlive()) {
    showImportError(extensionInvalidatedUserMessage);
    return;
  }

  try {
    // Pick article directory — gets .md + all media files in one step
    const dirFiles = await pickArticleDirectory();
    if (dirFiles.length === 0) return;

    const markdownFile = dirFiles.find((f) =>
      /\.(md|markdown|mdx)$/i.test(f.webkitRelativePath || f.name),
    );
    if (!markdownFile) {
      showImportError("未在目录中找到 Markdown 文件");
      return;
    }

    const markdown = await readFileAsText(markdownFile);
    let authorizedFiles = dirFiles;
    let registry = buildMediaRegistry({ markdown, authorizedFiles });

    // 1) Try regex on raw markdown
    const coverPatterns = [
      /^cover:\s*(\S+)/im,
      /!\[[^\]]*cover[^\]]*\]\(([^)\s]+)\)/i,
      /!\[[^\]]*\]\(([^)\s]+)\)/,
      /<img[^>]+src=["']([^"']+)["'][^>]*>/i,
    ];
    let rawCoverPath: string | null = null;
    for (const re of coverPatterns) {
      const m = markdown.match(re);
      if (m?.[1]) { rawCoverPath = m[1]; break; }
    }
    // 2) Fallback: find any file with "cover" in its name
    if (!rawCoverPath) {
      const coverFile = authorizedFiles.find((f) =>
        /cover\.(png|jpe?g|webp|gif|svg)$/i.test(f.webkitRelativePath || f.name),
      );
      if (coverFile) rawCoverPath = coverFile.webkitRelativePath || coverFile.name;
    }

    // Extract ALL image paths from raw markdown
    const rawImagePaths = [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
      .map((m) => m[1]!)
      .filter((p) => !/^https?:/i.test(p));

    // Count structural elements from raw markdown
    const conversionStats: { label: string; count: number }[] = [];
    const h2Count = (markdown.match(/^##\s+.+$/gm) ?? []).length;
    if (h2Count > 0) conversionStats.push({ label: "H2", count: h2Count });
    const h3Count = (markdown.match(/^###\s+.+$/gm) ?? []).length;
    if (h3Count > 0) conversionStats.push({ label: "H3", count: h3Count });
    const codeBlockCount = (markdown.match(/```[\s\S]*?```/g) ?? []).length;
    if (codeBlockCount > 0) conversionStats.push({ label: "Code block", count: codeBlockCount });
    const tableCount = (markdown.match(/^\|.+\|$/gm) ?? []).length;
    if (tableCount > 0) conversionStats.push({ label: "Table row", count: tableCount });
    let subscriptionTier = await loadSubscriptionTier();
    let confirmedTier = subscriptionTier;

    let coverBlobUrl: string | undefined;

    const findCoverFile = (coverPath: string): File | undefined => {
      const resolved = registry.resolveMediaPath(coverPath);
      const exact = registry.getUploadable(resolved);
      if (exact) return exact;

      const targetName = coverPath.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
      if (!targetName) return undefined;
      return authorizedFiles.find(
        (f) => (f.webkitRelativePath || f.name).replaceAll("\\", "/").split("/").pop()?.toLowerCase() === targetName,
      );
    };

    const buildPreview = (): ImportPreview => {
      if (coverBlobUrl) URL.revokeObjectURL(coverBlobUrl);
      coverBlobUrl = undefined;

      const preview = buildImportPreviewState({ markdown, subscriptionTier, mediaRegistry: registry });
      if (preview.adaptations.length === 0 && conversionStats.length > 0) {
        for (const s of conversionStats) {
          preview.adaptations.push({ kind: s.label, message: `${s.label} (×${s.count})` } as never);
        }
      }
      if (!preview.coverImage && rawCoverPath) preview.coverImage = rawCoverPath;
      const coverPath = preview.coverImage;
      if (preview.contentImages.length === 0) {
        // Combine regex results + directory scan (find all image files that aren't the cover)
        const isImage = (name: string) => /\.(png|jpe?g|webp|gif|svg)$/i.test(name);
        const dirImages = authorizedFiles
          .map((f) => f.webkitRelativePath || f.name)
          .filter((p) => isImage(p) && p !== coverPath);
        // Merge regex paths and directory paths, deduplicate
        const allPaths = [...new Set([...rawImagePaths.filter((p) => p !== coverPath), ...dirImages])];
        preview.contentImages = allPaths;
        preview.contentImageCount = allPaths.length;
      }
      if (coverPath && !/^https?:/i.test(coverPath)) {
        const coverFile = findCoverFile(coverPath);
        if (coverFile) {
          coverBlobUrl = URL.createObjectURL(coverFile);
          preview.coverObjectUrl = coverBlobUrl;
        }
      }
      return preview;
    };

    subscriptionTier = await loadSubscriptionTier();
    const dialog = await showImportPreviewDialog(buildPreview(), {
      onPickDirectory: async () => {
        const files = await pickMediaDirectory();
        if (files.length > 0) {
          authorizedFiles = [...authorizedFiles, ...files];
          registry = buildMediaRegistry({ markdown, authorizedFiles });
        }
        subscriptionTier = await loadSubscriptionTier();
        return buildPreview();
      },
      onPickFiles: async () => {
        const files = await pickSupplementalMedia();
        if (files.length > 0) {
          authorizedFiles = [...authorizedFiles, ...files];
          registry = buildMediaRegistry({ markdown, authorizedFiles });
        }
        subscriptionTier = await loadSubscriptionTier();
          return buildPreview();
        },
      },
    );

    if (dialog.type !== "confirm") return; // cancel or unreachable pick-* with callbacks
    confirmedTier = dialog.subscriptionTier;

    let loading: ImportLoadingHandle | null = showImportLoading(
      mode === "new-draft" ? "正在新建草稿…" : "正在确认当前草稿…",
    );
    try {
      if (mode === "new-draft") {
        loading.update("正在新建草稿…");
        await createNewArticleDraft();
      } else {
        loading.update("正在确认当前草稿…");
        await waitForArticleDraftReady();
      }

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
        filteredVideos: result.filteredVideos,
      });
    } finally {
      loading?.close();
    }
  } catch (err: unknown) {
    dismissOpenOverlays();
    showImportError(toUserFacingImportError(err));
  }
};

const observer = new MutationObserver(scheduleMountImportButtons);

observer.observe(document.documentElement, { childList: true, subtree: true });
patchHistoryNavigation();
scheduleMountImportButtons();
startMountRetryWindow();
