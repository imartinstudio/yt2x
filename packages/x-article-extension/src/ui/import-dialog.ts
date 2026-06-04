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
    warn: dark ? "rgba(245,158,11,0.12)" : "rgba(245,158,11,0.1)",
    warnText: dark ? "#fbbf24" : "#b45309",
    success: dark ? "#34d399" : "#059669",
    danger: dark ? "#f87171" : "#dc2626",
    border: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
    shadow: dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.15)",
  };

  const hasMissing = preview.missingSources.length > 0;

  const statParts: string[] = [];
  if (preview.contentImageCount > 0) statParts.push(`${preview.contentImageCount} 张图片`);
  if (preview.contentVideoCount > 0) statParts.push(`${preview.contentVideoCount} 个视频`);
  const statLine = statParts.length > 0 ? statParts.join("、") : "无素材";

  const adaptationText =
    preview.adaptations.length === 0
      ? ""
      : preview.adaptations.map((a) => a.message).join("；");

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
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: ${c.bg};
    border-radius: 16px;
    padding: 28px 28px 24px;
    box-shadow: 0 0 0 1px ${c.border}, 0 16px 48px ${c.shadow};
    display: flex; flex-direction: column; gap: 22px;
    animation: yt-enter 200ms cubic-bezier(0.22,1,0.36,1);
  }
  @keyframes yt-enter {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .panel-title {
    margin: 0;
    font-size: 13px; font-weight: 600;
    color: ${c.muted};
    text-transform: uppercase; letter-spacing: 0.04em;
  }

  .title-block {
    display: flex; flex-direction: column; gap: 6px;
  }
  .article-title {
    margin: 0;
    font-size: 19px; font-weight: 700; line-height: 1.3;
    color: ${c.text};
    word-break: break-word;
  }
  .cover-ref {
    font-size: 12px; color: ${c.muted};
    display: flex; align-items: center; gap: 6px;
  }
  .cover-ref::before {
    content: ''; display: inline-block;
    width: 14px; height: 14px;
    background: ${c.surface}; border-radius: 3px;
  }

  .meta-row {
    display: flex; gap: 24px; flex-wrap: wrap;
    font-size: 13px; color: ${c.muted};
  }
  .meta-label { font-weight: 500; color: ${c.text}; }

  .adapt-block {
    font-size: 12px; color: ${c.muted}; line-height: 1.5;
    padding: 10px 14px;
    background: ${c.surface}; border-radius: 10px;
  }

  .missing-block {
    background: ${c.warn}; border-radius: 10px;
    padding: 14px 16px;
    display: ${hasMissing ? "flex" : "none"};
    flex-direction: column; gap: 10px;
  }
  .missing-label {
    font-size: 12px; font-weight: 600; color: ${c.warnText}; margin: 0;
  }
  .missing-list {
    font-size: 12px; color: ${c.muted};
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    word-break: break-all; line-height: 1.6;
  }
  .media-actions {
    display: flex; gap: 8px; flex-wrap: wrap;
  }

  .tier-row {
    display: flex; align-items: center; gap: 12px;
    font-size: 13px; color: ${c.muted};
  }
  .tier-label {
    font-size: 13px; color: ${c.muted}; flex-shrink: 0;
  }
  .tier-seg {
    display: inline-flex;
    border: 1px solid ${c.border};
    border-radius: 10px;
    overflow: hidden;
  }
  .tier-seg label {
    cursor: pointer; position: relative;
  }
  .tier-seg input {
    position: absolute; opacity: 0; width: 0; height: 0;
  }
  .tier-seg span {
    display: block;
    padding: 7px 18px;
    font-size: 13px; font-weight: 500;
    color: ${c.muted};
    background: transparent;
    transition: background 180ms ease, color 180ms ease;
    user-select: none;
  }
  .tier-seg label:first-child span {
    border-right: 1px solid ${c.border};
  }
  .tier-seg input:checked + span {
    background: ${c.surface};
    color: ${c.text};
    font-weight: 600;
  }

  .actions {
    display: flex; gap: 10px; align-items: center;
  }

  .btn-primary {
    flex: 1;
    border: none; border-radius: 12px;
    padding: 13px 20px;
    font-size: 15px; font-weight: 600;
    background: ${c.accent}; color: #fff;
    cursor: pointer;
    transition: background 150ms;
  }
  .btn-primary:hover:not(:disabled) { background: ${c.accentHover}; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    border: 1px solid ${c.border}; border-radius: 10px;
    padding: 9px 14px; font-size: 13px;
    background: ${c.surface}; color: ${c.text}; cursor: pointer;
    transition: background 120ms;
  }
  .btn-secondary:hover { background: ${c.border}; }

  .btn-ghost {
    border: none; background: none;
    color: ${c.muted}; cursor: pointer;
    font-size: 13px; padding: 8px 12px; border-radius: 8px;
    transition: color 120ms, background 120ms;
  }
  .btn-ghost:hover { color: ${c.text}; background: ${c.surface}; }

  .warning-block {
    font-size: 12px; color: ${c.warnText}; line-height: 1.5;
    padding: 10px 14px;
    background: ${c.warn}; border-radius: 10px;
  }
</style>

<div class="backdrop" role="dialog" aria-modal="true" aria-label="导入确认">
  <div class="panel">
    <p class="panel-title">导入 Markdown</p>

    <div class="title-block">
      <h2 class="article-title">${escapeHtml(preview.title)}</h2>
      <div class="cover-ref">${escapeHtml(preview.coverImage ?? "无封面")}</div>
    </div>

    <div class="meta-row">
      <span><span class="meta-label">素材</span> ${statLine}</span>
      ${adaptationText ? `<span><span class="meta-label">转换</span> ${escapeHtml(adaptationText)}</span>` : ""}
    </div>

    ${preview.warnings.length > 0 ? `<div class="warning-block">${preview.warnings.map(escapeHtml).join("<br>")}</div>` : ""}

    <div class="missing-block">
      <p class="missing-label">缺少素材文件</p>
      <div class="missing-list">${preview.missingSources.map(escapeHtml).join("、")}</div>
      <div class="media-actions">
        <button class="btn-secondary" type="button" data-action="pick-directory">选择文章目录</button>
        <button class="btn-secondary" type="button" data-action="pick-files">选择素材文件</button>
      </div>
    </div>

    <div class="tier-row">
      <span class="tier-label">订阅档位</span>
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
      <button class="btn-primary" type="button" data-action="confirm" ${hasMissing ? "disabled" : ""}>确认导入</button>
      <button class="btn-ghost" type="button" data-action="cancel">取消</button>
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
