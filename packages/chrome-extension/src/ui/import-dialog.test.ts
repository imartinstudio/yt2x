import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRegistry } from "../files/local-media.js";

const runtimeMocks = vi.hoisted(() => ({
  loadSubscriptionTier: vi.fn(),
  saveSubscriptionTier: vi.fn(),
}));

vi.mock("../runtime/extension-runtime.js", () => runtimeMocks);

import {
  buildImportPreview,
  buildImportPreviewState,
  showImportError,
  showImportPreviewDialog,
  showImportSuccessToast,
} from "./import-dialog.js";

describe("X Articles import media policy", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("requires unresolved body images before confirmation and ignores videos", () => {
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
    expect(preview.missingSources).toEqual(["images/scene.png"]);
  });

  it("reports skipped content images and filtered videos", () => {
    vi.useFakeTimers();
    showImportSuccessToast({
      manualContentMedia: ["images/scene.png"],
      filteredVideos: ["media/clip.mp4"],
    });

    const text = document.querySelector("[data-yt2x-import-toast]")?.textContent ?? "";
    expect(text).toContain("1 个正文图片未自动插入，请手动补充");
    expect(text).toContain("1 个视频已过滤");
    vi.runAllTimers();
    expect(document.querySelector("[data-yt2x-import-toast]")).toBeNull();
  });

  it("summarizes cover upload failures and skipped structural content", () => {
    vi.useFakeTimers();
    showImportSuccessToast({
      skippedDividers: [2, 4],
      skippedPromptCodeBlocks: 1,
      skippedMedia: ["cover.png"],
      lastMediaError: "upload failed",
    });

    const text = document.querySelector("[data-yt2x-import-toast]")?.textContent ?? "";
    expect(text).toContain("2 处分割线未插入");
    expect(text).toContain("1 个素材上传失败，正文格式已保留：upload failed");
    expect(text).toContain("1 段英文 prompt 代码块已跳过");
    vi.runAllTimers();
    expect(document.querySelector("[data-yt2x-import-toast]")).toBeNull();
  });

  it("builds preview state from a prepared import and checks missing cover and image sources", () => {
    const registry = {
      missingSources: ["cover.png", "images/body.png"],
      resolveMediaPath: (source: string) => source,
      getUploadable: () => undefined,
    } as unknown as MediaRegistry;

    const preview = buildImportPreview({
      prepared: {
        parseResult: {
          title: "标题",
          coverImage: "cover.png",
          contentImages: [{ path: "images/body.png" }],
          contentVideos: [],
        },
        adapted: { adaptations: [{ kind: "premium-image", message: "converted" }], warnings: ["warn"] },
        mediaRegistry: registry,
      } as never,
    });

    expect(preview).toMatchObject({
      title: "标题",
      coverImage: "cover.png",
      contentImageCount: 1,
      contentVideoCount: 0,
      missingSources: ["cover.png", "images/body.png"],
    });
  });

  it("blocks confirmation until missing cover and body image media is authorized", async () => {
    runtimeMocks.saveSubscriptionTier.mockResolvedValue(undefined);
    const result = showImportPreviewDialog({
      title: "A <title>",
      coverImage: "cover.png",
      contentImageCount: 1,
      contentVideoCount: 1,
      adaptations: [{ kind: "premium-image", message: "Use <image>" }],
      warnings: ["Careful <warning>"],
      missingSources: ["cover.png", "images/body.png"],
    });
    const host = document.querySelector("[data-yt2x-import-dialog]") as HTMLElement;
    const shadow = host.shadowRoot!;

    expect(shadow.textContent).toContain("仍缺少封面或正文图片素材：cover.png, images/body.png");
    shadow.querySelector<HTMLButtonElement>("[data-action='confirm']")!.click();
    await Promise.resolve();
    expect(host.isConnected).toBe(true);

    shadow.querySelector<HTMLButtonElement>("[data-action='pick-files']")!.click();
    await expect(result).resolves.toEqual({ type: "pick-files" });
    expect(runtimeMocks.saveSubscriptionTier).toHaveBeenCalledWith("premium");
    expect(host.isConnected).toBe(false);
  });

  it("saves the selected tier when confirming the import preview", async () => {
    runtimeMocks.saveSubscriptionTier.mockResolvedValue(undefined);
    const result = showImportPreviewDialog({
      title: "标题",
      coverImage: null,
      contentImageCount: 0,
      contentVideoCount: 0,
      adaptations: [],
      warnings: [],
      missingSources: [],
    });
    const host = document.querySelector("[data-yt2x-import-dialog]") as HTMLElement;
    const shadow = host.shadowRoot!;
    shadow.querySelector<HTMLSelectElement>("[name='subscription-tier']")!.value = "premium-plus";
    shadow.querySelector<HTMLButtonElement>("[data-action='confirm']")!.click();

    await expect(result).resolves.toEqual({
      type: "confirm",
      subscriptionTier: "premium-plus",
    });
    expect(runtimeMocks.saveSubscriptionTier).toHaveBeenCalledWith("premium-plus");
  });

  it("renders import errors with prefixed text and the longer refresh timeout", () => {
    vi.useFakeTimers();
    showImportError("请刷新页面后重试");

    const toast = document.querySelector("[data-yt2x-import-error]");
    expect(toast?.textContent).toBe("yt2x 导入失败：请刷新页面后重试");
    vi.advanceTimersByTime(11_999);
    expect(document.querySelector("[data-yt2x-import-error]")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector("[data-yt2x-import-error]")).toBeNull();
  });
});
