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

import {
  loadSubscriptionTier,
  saveSubscriptionTier,
} from "../runtime/extension-runtime.js";

export { loadSubscriptionTier, saveSubscriptionTier };

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
    omitDividers: true,
  });
  const missingSources = missingCoverSources(parseResult.coverImage, input.mediaRegistry);
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

export const showImportPreviewDialog = (preview: ImportPreview): Promise<ImportDialogResult> =>
  new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-yt2x-import-dialog", "true");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = renderDialogHtml(preview);

    const readTier = (): XArticleSubscriptionTier => {
      const tierInput = shadow.querySelector<HTMLSelectElement>("[name='subscription-tier']");
      return tierInput?.value === "premium-plus" ? "premium-plus" : "premium";
    };

    const close = (result: ImportDialogResult): void => {
      host.remove();
      resolve(result);
    };

    shadow.querySelector("[data-action='cancel']")?.addEventListener("click", () => {
      close({ type: "cancel" });
    });
    shadow.querySelector("[data-action='pick-directory']")?.addEventListener("click", () => {
      void saveSubscriptionTier(readTier()).then(() => {
        close({ type: "pick-directory" });
      });
    });
    shadow.querySelector("[data-action='pick-files']")?.addEventListener("click", () => {
      void saveSubscriptionTier(readTier()).then(() => {
        close({ type: "pick-files" });
      });
    });
    shadow.querySelector("[data-action='confirm']")?.addEventListener("click", () => {
      if (preview.missingSources.length > 0) return;
      void saveSubscriptionTier(readTier()).then(() => {
        close({ type: "confirm", subscriptionTier: readTier() });
      });
    });

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
  missingSources: missingCoverSources(
    input.prepared.parseResult.coverImage,
    input.prepared.mediaRegistry,
  ),
});

export const showImportSuccessToast = (input: {
  skippedDividers?: number[];
  skippedPromptCodeBlocks?: number;
  skippedMedia?: string[];
  lastMediaError?: string | null;
  manualContentMedia?: string[];
} = {}): void => {
  const skippedDividers = input.skippedDividers ?? [];
  const skippedPromptCodeBlocks = input.skippedPromptCodeBlocks ?? 0;
  const skippedMedia = input.skippedMedia ?? [];
  const lastMediaError = input.lastMediaError ?? null;
  const manualContentMedia = input.manualContentMedia ?? [];
  const toast = document.createElement("div");
  toast.setAttribute("data-yt2x-import-toast", "true");
  const notes: string[] = [];
  if (skippedDividers.length > 0) {
    notes.push(`${skippedDividers.length} 处分割线未插入，请手动补 Divider`);
  }
  if (skippedMedia.length > 0) {
    const detail =
      lastMediaError !== null && lastMediaError.length > 0 ? `：${lastMediaError}` : "";
    notes.push(`${skippedMedia.length} 个封面上传失败，正文格式已保留${detail}`);
  }
  if (manualContentMedia.length > 0) {
    notes.push(`${manualContentMedia.length} 个正文图片/视频未自动插入，请手动补充`);
  }
  if (skippedPromptCodeBlocks > 0) {
    notes.push(`${skippedPromptCodeBlocks} 段英文 prompt 代码块已跳过（非正文内容）`);
  }
  const suffix = notes.length > 0 ? `（${notes.join("；")}）` : "";
  toast.textContent = `草稿内容已写入，请人工复核后发布${suffix}`;
  toast.style.cssText =
    "position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 16px;border-radius:8px;background:#111;color:#fff;font:14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)";
  document.body.appendChild(toast);
  window.setTimeout(
    () => toast.remove(),
    skippedMedia.length > 0 || manualContentMedia.length > 0 ? 15_000 : 6_000,
  );
};

export const showImportError = (message: string): void => {
  const toast = document.createElement("div");
  toast.setAttribute("data-yt2x-import-error", "true");
  toast.textContent = message.startsWith("yt2x") ? message : `yt2x 导入失败：${message}`;
  toast.style.cssText =
    "position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:min(420px,calc(100vw - 48px));padding:14px 16px;border-radius:8px;background:#b42318;color:#fff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)";
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), message.includes("刷新") ? 12_000 : 8_000);
};

const renderDialogHtml = (preview: ImportPreview): string => {
  const adaptationLines =
    preview.adaptations.length === 0
      ? "<li>无 Premium 降级项</li>"
      : preview.adaptations.map((item) => `<li>${escapeHtml(item.message)}</li>`).join("");
  const warningLines =
    preview.warnings.length === 0
      ? ""
      : `<section><h3>警告</h3><ul>${preview.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></section>`;
  const missingLines =
    preview.missingSources.length === 0
      ? "<p>封面素材已齐全；正文图片/视频需在导入后手动插入。</p>"
      : `<p class="error">仍缺少封面素材：${preview.missingSources.map(escapeHtml).join(", ")}</p>`;
  const mediaActions =
    preview.missingSources.length === 0
      ? ""
      : `<div class="media-actions">
      <button type="button" data-action="pick-directory">选择文章目录</button>
      <button type="button" data-action="pick-files">选择素材文件</button>
    </div>
    <p class="meta">请在确认导入前授权封面文件；正文图片/视频暂不自动插入。</p>`;

  return `
<style>
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,.45); display: grid; place-items: center;
    font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #111;
  }
  .panel {
    width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
    overflow: auto; background: #fff; border-radius: 12px; padding: 20px;
    box-shadow: 0 16px 48px rgba(0,0,0,.2);
  }
  h2 { margin: 0 0 12px; font-size: 18px; }
  h3 { margin: 16px 0 8px; font-size: 14px; }
  ul { margin: 0; padding-left: 20px; }
  .meta { margin: 0 0 8px; color: #536471; }
  .error { color: #b42318; }
  .media-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button, select { font: inherit; }
  button {
    border: 1px solid #d0d7de; border-radius: 8px; padding: 8px 12px;
    background: #f6f8fa; cursor: pointer;
  }
  button[data-action='confirm'] { background: #111; color: #fff; border-color: #111; }
  button:disabled { opacity: .45; cursor: not-allowed; }
</style>
<div class="backdrop" role="dialog" aria-modal="true" aria-label="导入 Markdown 预览">
  <div class="panel">
    <h2>导入 Markdown 预览</h2>
    <p class="meta"><strong>标题：</strong>${escapeHtml(preview.title)}</p>
    <p class="meta"><strong>封面：</strong>${escapeHtml(preview.coverImage ?? "（无）")}</p>
    <p class="meta"><strong>正文素材：</strong>${preview.contentImageCount} 张图片，${preview.contentVideoCount} 个视频（不含封面，导入后请手动插入）</p>
    <label>订阅档位
      <select name="subscription-tier">
        <option value="premium">X Premium</option>
        <option value="premium-plus">X Premium+</option>
      </select>
    </label>
    <section>
      <h3>转换摘要</h3>
      <ul>${adaptationLines}</ul>
    </section>
    ${warningLines}
    <section><h3>素材</h3>${missingLines}${mediaActions}</section>
    <p class="meta">确认后将点击「添加」新建空白草稿，再写入上述内容。</p>
    <div class="actions">
      <button type="button" data-action="cancel">取消</button>
      <button type="button" data-action="confirm" ${preview.missingSources.length > 0 ? "disabled" : ""}>确认导入</button>
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

const missingCoverSources = (coverImage: string | null, registry: MediaRegistry): string[] => {
  if (coverImage === null || registry.getUploadable(coverImage) !== undefined) return [];
  return registry.missingSources.filter(
    (source) => registry.resolveMediaPath(source) === coverImage,
  );
};
