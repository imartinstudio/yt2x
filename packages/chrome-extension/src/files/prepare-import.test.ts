import { describe, expect, it } from "vitest";
import { prepareArticleImport, resolveUploadFile } from "./prepare-import.js";
import type { MediaRegistry } from "./local-media.js";

describe("prepareArticleImport", () => {
  it("maps code blocks and dividers to native X editor operations", async () => {
    const mediaRegistry = {
      missingSources: [],
      resolveMediaPath: (source: string) => source,
      getUploadable: () => undefined,
    } as unknown as MediaRegistry;

    const prepared = await prepareArticleImport({
      markdown: [
        "# 标题",
        "",
        "正文内容。",
        "",
        "```bash",
        "pnpm test",
        "```",
        "",
        "---",
        "",
        "尾段。",
      ].join("\n"),
      subscriptionTier: "premium",
      mediaRegistry,
    });

    expect(prepared.parseResult.contentCodeBlocks).toEqual([
      expect.objectContaining({
        code: "pnpm test",
        language: "bash",
      }),
    ]);
    expect(prepared.parseResult.dividers.length).toBeGreaterThan(0);
    expect(prepared.parseResult.html).not.toContain("<pre><code>");
    expect(prepared.parseResult.html).not.toContain("<hr>");
  });

  it("allows unresolved body media because it is inserted manually after import", async () => {
    const mediaRegistry = {
      missingSources: ["images/scene.png", "media/clip.mp4"],
      resolveMediaPath: (source: string) => source,
      getUploadable: () => undefined,
    } as unknown as MediaRegistry;

    const prepared = await prepareArticleImport({
      markdown: [
        "# 标题",
        "",
        "![cover](https://example.test/cover.png)",
        "",
        "正文内容。",
        "",
        "![scene](images/scene.png)",
        "",
        '<video src="media/clip.mp4"></video>',
      ].join("\n"),
      subscriptionTier: "premium",
      mediaRegistry,
    });

    expect(prepared.parseResult.contentImages).toHaveLength(1);
    expect(prepared.parseResult.contentVideos).toHaveLength(1);
  });

  it("requires unresolved local cover media before import", async () => {
    const mediaRegistry = {
      missingSources: ["images/cover.png", "images/body.png"],
      resolveMediaPath: (source: string) => source,
      getUploadable: () => undefined,
    } as unknown as MediaRegistry;

    await expect(
      prepareArticleImport({
        markdown: ["# 标题", "", "![cover](images/cover.png)", "", "![body](images/body.png)"].join(
          "\n",
        ),
        subscriptionTier: "premium",
        mediaRegistry,
      }),
    ).rejects.toThrow("Missing authorized cover media: images/cover.png");
  });

  it("resolves generated blobs before falling back to local media", () => {
    const localFile = new File(["local"], "local.png", { type: "image/png" });
    const prepared = {
      generatedBlobs: new Map([["generated.png", new Blob(["generated"], { type: "image/png" })]]),
      mediaRegistry: {
        getUploadable: (path: string) => (path === "local.png" ? localFile : undefined),
      },
    } as never;

    const generated = resolveUploadFile(prepared, "generated.png");
    expect(generated).toBeInstanceOf(File);
    expect(generated?.name).toBe("generated.png");
    expect(generated?.type).toBe("image/png");
    expect(resolveUploadFile(prepared, "local.png")).toBe(localFile);
    expect(resolveUploadFile(prepared, "missing.png")).toBeUndefined();
  });
});
