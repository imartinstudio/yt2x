import {
  adaptArticleForX,
  parseArticleDraftFromMarkdown,
  type AdaptArticleForXResult,
  type XArticleSubscriptionTier,
} from "@yt2x/core";
import type { MediaRegistry } from "../files/local-media.js";
import type { PreparedArticleImport } from "../files/prepare-import.js";

export type ImportPreview = {
  title: string;
  coverImage: string | null;
  contentImageCount: number;
  contentVideoCount: number;
  adaptations: AdaptArticleForXResult["adaptations"];
  warnings: string[];
  missingSources: string[];
};

export type ImportDialogResult =
  | { type: "cancel" }
  | { type: "confirm"; subscriptionTier: XArticleSubscriptionTier }
  | { type: "pick-directory" }
  | { type: "pick-files" };

export type ImportDialogCallbacks = {
  onPickDirectory: () => Promise<ImportPreview>;
  onPickFiles: () => Promise<ImportPreview>;
};

import {
  loadSubscriptionTier,
  saveSubscriptionTier,
} from "../runtime/extension-runtime.js";

export { loadSubscriptionTier, saveSubscriptionTier };

const isDarkMode = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

export const buildImportPreviewState = (input: {
  markdown: string;
  subscriptionTier: XArticleSubscriptionTier;
  mediaRegistry: MediaRegistry;
}): ImportPreview => {
  const adapted = adaptArticleForX({
    markdown: input.markdown,
    subscriptionTier: input.subscriptionTier,
  });
  const parseResult = parseArticleDraftFromMarkdown(adapted.markdown, {
    resolveMediaPath: (source) => input.mediaRegistry.resolveMediaPath(source),
    preserveSourceContent: true,
    useNativeEditorBlocks: true,
    omitDividers: false,
  });
  const missingSources = missingUploadSources(parseResult, input.mediaRegistry);
  return {
    title: parseResult.title,
    coverImage: parseResult.coverImage,
    contentImageCount: parseResult.contentImages.length,
    contentVideoCount: parseResult.contentVideos.length,
    adaptations: adapted.adaptations,
    warnings: adapted.warnings,
    missingSources,
  };
};

export const showImportPreviewDialog = (
  preview: ImportPreview,
  callbacks?: ImportDialogCallbacks,
): Promise<ImportDialogResult> =>
  new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-yt2x-import-dialog", "true");
    const shadow = host.attachShadow({ mode: "open" });

    let currentPreview = preview;

    const render = (): void => {
      shadow.innerHTML = renderDialogHtml(currentPreview);
      bindEvents();
    };

    const readTier = (): XArticleSubscriptionTier => {
      const checked = shadow.querySelector<HTMLInputElement>("[name='subscription-tier']:checked");
      return checked?.value === "premium-plus" ? "premium-plus" : "premium";
    };

    const close = (result: ImportDialogResult): void => {
      host.remove();
      resolve(result);
    };

    const bindEvents = (): void => {
      shadow.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
        close({ type: "cancel" });
      });

      const pickDirBtn = shadow.querySelector("[data-action='pick-directory']");
      const pickFilesBtn = shadow.querySelector("[data-action='pick-files']");

      if (callbacks) {
        // Inline mode: dialog stays open, re-renders with updated preview
        pickDirBtn?.addEventListener("click", async () => {
          try {
            currentPreview = await callbacks.onPickDirectory();
            render();
          } catch {
            /* cancelled */
          }
        });
        pickFilesBtn?.addEventListener("click", async () => {
          try {
            currentPreview = await callbacks.onPickFiles();
            render();
          } catch {
            /* cancelled */
          }
        });
      } else {
        // Legacy mode: close dialog and let caller handle picking
        pickDirBtn?.addEventListener("click", () => {
          void saveSubscriptionTier(readTier()).then(() => {
            close({ type: "pick-directory" });
          });
        });
        pickFilesBtn?.addEventListener("click", () => {
          void saveSubscriptionTier(readTier()).then(() => {
            close({ type: "pick-files" });
          });
        });
      }

      shadow.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
        if (currentPreview.missingSources.length > 0) return;
        void saveSubscriptionTier(readTier()).then(() => {
          close({ type: "confirm", subscriptionTier: readTier() });
        });
      });
    };

    render();
    document.body.appendChild(host);
  });

export const buildImportPreview = (input: {
  prepared: PreparedArticleImport;
}): ImportPreview => ({
  title: input.prepared.parseResult.title,
  coverImage: input.prepared.parseResult.coverImage,
  contentImageCount: input.prepared.parseResult.contentImages.length,
  contentVideoCount: input.prepared.parseResult.contentVideos.length,
  adaptations: input.prepared.adapted.adaptations,
  warnings: input.prepared.adapted.warnings,
  missingSources: missingUploadSources(input.prepared.parseResult, input.prepared.mediaRegistry),
});

export const showImportSuccessToast = (input: {
  skippedDividers?: number[];
  skippedPromptCodeBlocks?: number;
  skippedMedia?: string[];
  lastMediaError?: string | null;
  manualContentMedia?: string[];
  filteredVideos?: string[];
} = {}): void => {
  const skippedDividers = input.skippedDividers ?? [];
  const skippedPromptCodeBlocks = input.skippedPromptCodeBlocks ?? 0;
  const skippedMedia = input.skippedMedia ?? [];
  const lastMediaError = input.lastMediaError ?? null;
  const manualContentMedia = input.manualContentMedia ?? [];
  const filteredVideos = input.filteredVideos ?? [];
  const toast = document.createElement("div");
  toast.setAttribute("data-yt2x-import-toast", "true");
  const notes: string[] = [];
  if (skippedDividers.length > 0) {
    notes.push(`${skippedDividers.length} 处分割线未插入，请手动补 Divider`);
  }
  if (skippedMedia.length > 0) {
    const detail =
      lastMediaError !== null && lastMediaError.length > 0 ? `：${lastMediaError}` : "";
    notes.push(`${skippedMedia.length} 个素材上传失败，正文格式已保留${detail}`);
  }
  if (manualContentMedia.length > 0) {
    notes.push(`${manualContentMedia.length} 个正文图片未自动插入，请手动补充`);
  }
  if (filteredVideos.length > 0) {
    notes.push(`${filteredVideos.length} 个视频已过滤`);
  }
  if (skippedPromptCodeBlocks > 0) {
    notes.push(`${skippedPromptCodeBlocks} 段英文 prompt 代码块已跳过（非正文内容）`);
  }
  const suffix = notes.length > 0 ? `（${notes.join("；")}）` : "";
  toast.textContent = `草稿内容已写入，请人工复核后发布${suffix}`;

  const dark = isDarkMode();
  const bg = dark ? "#2c2c2e" : "#1c1c1e";
  const fg = dark ? "#e4e4e5" : "#ffffff";
  const border = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.1)";
  toast.style.cssText = `
    position:fixed;right:20px;bottom:20px;z-index:2147483647;
    max-width:min(400px,calc(100vw - 40px));
    padding:12px 16px;border-radius:12px;
    background:${bg};color:${fg};
    font:14px/1.5 system-ui,-apple-system,sans-serif;
    box-shadow:0 0 0 1px ${border},0 8px 28px rgba(0,0,0,.2);
  `;
  document.body.appendChild(toast);
  window.setTimeout(
    () => toast.remove(),
    skippedMedia.length > 0 || manualContentMedia.length > 0 || filteredVideos.length > 0 ? 15_000 : 6_000,
  );
};

export const showImportError = (message: string): void => {
  const toast = document.createElement("div");
  toast.setAttribute("data-yt2x-import-error", "true");
  toast.textContent = message.startsWith("yt2x") ? message : `yt2x 导入失败：${message}`;

  const dark = isDarkMode();
  const bg = dark ? "#451a1a" : "#fef2f2";
  const fg = dark ? "#fca5a5" : "#991b1b";
  const border = dark ? "rgba(248,113,113,0.2)" : "rgba(220,38,38,0.15)";
  toast.style.cssText = `
    position:fixed;right:20px;bottom:20px;z-index:2147483647;
    max-width:min(420px,calc(100vw - 40px));
    padding:12px 16px;border-radius:12px;
    background:${bg};color:${fg};
    font:14px/1.5 system-ui,-apple-system,sans-serif;
    box-shadow:0 0 0 1px ${border},0 8px 28px rgba(0,0,0,.2);
  `;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), message.includes("刷新") ? 12_000 : 8_000);
};

const renderDialogHtml = (preview: ImportPreview): string => {
  const dark = isDarkMode();
  const c = {
    bg: dark ? "#1c1c1e" : "#ffffff",
    surface: dark ? "#2c2c2e" : "#f5f5f7",
    text: dark ? "#e4e4e5" : "#1d1d1f",
    muted: dark ? "#8e8e93" : "#6e6e73",
    accent: dark ? "#3b82f6" : "#2563eb",
    accentHover: dark ? "#2563eb" : "#1d4ed8",
    warnBg: dark ? "rgba(245,158,11,0.08)" : "rgba(245,158,11,0.06)",
    warnText: dark ? "#fbbf24" : "#b45309",
    border: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
    shadow: dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.15)",
  };

  const hasMissing = preview.missingSources.length > 0;

  const detailParts: string[] = [];
  if (preview.coverImage) detailParts.push(`Cover: ${preview.coverImage}`);
  if (preview.contentImageCount > 0) detailParts.push(`${preview.contentImageCount} images`);
  if (preview.contentVideoCount > 0) detailParts.push(`${preview.contentVideoCount} videos`);
  if (preview.adaptations.length > 0) detailParts.push(`${preview.adaptations.length} adaptations`);

  const missingChips = preview.missingSources
    .map(
      (src) =>
        `<span class="chip">${escapeHtml(src)} <button class="chip-add" data-action="pick-files">+</button></span>`,
    )
    .join("");

  return `
<style>
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,.35);
    display: grid; place-items: center;
    font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    color: ${c.text};
    animation: yt-fade 150ms ease-out;
  }
  @keyframes yt-fade { from { opacity: 0; } to { opacity: 1; } }

  .panel {
    width: min(400px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: ${c.bg};
    border-radius: 16px;
    padding: 28px 28px 24px;
    box-shadow: 0 0 0 1px ${c.border}, 0 20px 60px ${c.shadow};
    display: flex; flex-direction: column; gap: 20px;
    animation: yt-enter 220ms cubic-bezier(0.22,1,0.36,1);
  }
  @keyframes yt-enter {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .article-title {
    margin: 0;
    font-size: 20px; font-weight: 700; line-height: 1.35;
    color: ${c.text};
    word-break: break-word;
  }

  .detail-list {
    display: flex; flex-direction: column; gap: 6px;
    font-size: 13px; color: ${c.muted};
  }

  .divider {
    height: 1px; background: ${c.border}; margin: 0; border: none;
  }

  .missing-section {
    display: ${hasMissing ? "flex" : "none"};
    flex-direction: column; gap: 10px;
  }
  .missing-header {
    font-size: 11px; font-weight: 600; color: ${c.warnText};
    text-transform: uppercase; letter-spacing: 0.04em; margin: 0;
  }
  .chip-list {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    color: ${c.muted};
    background: ${c.warnBg}; border-radius: 5px;
    padding: 3px 6px 3px 10px;
  }
  .chip-add {
    border: none; background: ${c.warnText}; color: ${c.bg};
    width: 18px; height: 18px; border-radius: 4px;
    font-size: 12px; font-weight: 700; line-height: 1;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  }
  .chip-add:hover { filter: brightness(1.2); }
  .batch-link {
    border: none; background: none;
    color: ${c.muted}; cursor: pointer;
    font-size: 11px; padding: 0; width: fit-content;
    text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: ${c.border};
  }
  .batch-link:hover { color: ${c.text}; }

  .tier-row {
    display: flex; align-items: center; gap: 12px;
    font-size: 12px; color: ${c.muted};
  }
  .tier-seg {
    display: inline-flex;
    border: 1px solid ${c.border}; border-radius: 8px; overflow: hidden;
  }
  .tier-seg label { cursor: pointer; position: relative; }
  .tier-seg input { position: absolute; opacity: 0; width: 0; height: 0; }
  .tier-seg span {
    display: block; padding: 6px 14px;
    font-size: 12px; font-weight: 500; color: ${c.muted};
    background: transparent;
    transition: background 180ms ease, color 180ms ease;
    user-select: none;
  }
  .tier-seg label:first-child span { border-right: 1px solid ${c.border}; }
  .tier-seg input:checked + span { background: ${c.surface}; color: ${c.text}; font-weight: 600; }

  .actions {
    display: flex; gap: 10px; align-items: center;
  }
  .btn-primary {
    flex: 1;
    border: none; border-radius: 12px;
    padding: 13px 20px;
    font-size: 15px; font-weight: 600;
    background: ${c.accent}; color: #fff;
    cursor: pointer; transition: background 150ms;
  }
  .btn-primary:hover:not(:disabled) { background: ${c.accentHover}; }
  .btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-ghost {
    border: none; background: none;
    color: ${c.muted}; cursor: pointer;
    font-size: 13px; padding: 8px 14px; border-radius: 8px;
    transition: color 120ms, background 120ms;
  }
  .btn-ghost:hover { color: ${c.text}; background: ${c.surface}; }
</style>

<div class="backdrop" role="dialog" aria-modal="true" aria-label="Import">
  <div class="panel">

    <h2 class="article-title">${escapeHtml(preview.title)}</h2>

    <div class="detail-list">
      ${detailParts.map((d) => `<span>${escapeHtml(d)}</span>`).join("")}
    </div>

    ${hasMissing ? `<hr class="divider" />
    <div class="missing-section">
      <p class="missing-header">Missing assets</p>
      <div class="chip-list">${missingChips}</div>
      <button class="batch-link" type="button" data-action="pick-directory">Match from directory…</button>
    </div>` : ""}

    <hr class="divider" />

    <div class="tier-row">
      <span>Subscription</span>
      <div class="tier-seg">
        <label>
          <input type="radio" name="subscription-tier" value="premium" checked>
          <span>Premium</span>
        </label>
        <label>
          <input type="radio" name="subscription-tier" value="premium-plus">
          <span>Premium+</span>
        </label>
      </div>
    </div>

    <div class="actions">
      <button class="btn-primary" type="button" data-action="confirm" ${hasMissing ? "disabled" : ""}>Publish</button>
      <button class="btn-ghost" type="button" data-action="cancel">Cancel</button>
    </div>

  </div>
</div>`;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const missingUploadSources = (
  parseResult: Pick<PreparedArticleImport["parseResult"], "coverImage" | "contentImages">,
  registry: MediaRegistry,
): string[] => {
  const required = [
    ...(parseResult.coverImage === null ? [] : [parseResult.coverImage]),
    ...parseResult.contentImages.map((image) => image.path),
  ];
  return [
    ...new Set(
      required.filter((path) => registry.getUploadable(path) === undefined),
    ),
  ].flatMap((path) =>
    registry.missingSources.filter((source) => registry.resolveMediaPath(source) === path),
  );
};
