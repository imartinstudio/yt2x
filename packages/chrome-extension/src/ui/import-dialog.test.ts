import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRegistry } from "../files/local-media.js";
import { buildImportPreviewState, showImportSuccessToast } from "./import-dialog.js";

describe("X Articles import media policy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("does not block confirmation for unresolved body media", () => {
    const registry = {
      missingSources: ["images/scene.png", "media/clip.mp4"],
      resolveMediaPath: (source: string) => source,
      getUploadable: () => undefined,
    } as unknown as MediaRegistry;

    const preview = buildImportPreviewState({
      markdown: [
        "# 标题",
        "",
        "![cover](https://example.test/cover.png)",
        "",
        "正文。",
        "",
        "![scene](images/scene.png)",
        "",
        '<video src="media/clip.mp4"></video>',
      ].join("\n"),
      subscriptionTier: "premium",
      mediaRegistry: registry,
    });

    expect(preview.contentImageCount).toBe(1);
    expect(preview.contentVideoCount).toBe(1);
    expect(preview.missingSources).toEqual([]);
  });

  it("tells the user to insert deferred content media manually", () => {
    vi.useFakeTimers();
    showImportSuccessToast({ manualContentMedia: ["images/scene.png", "media/clip.mp4"] });

    expect(document.querySelector("[data-yt2x-import-toast]")?.textContent).toContain(
      "2 个正文图片/视频未自动插入，请手动补充",
    );
  });
});
