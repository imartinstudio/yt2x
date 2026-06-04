import { describe, expect, it } from "vitest";
import { buildMainWorldWritePayload } from "./markdown-to-draft-payload.js";
import type { PreparedArticleImport } from "../files/prepare-import.js";

describe("buildMainWorldWritePayload", () => {
  it("builds marker plans for code blocks and body images in document order", async () => {
    const imageFile = new File(["image"], "scene.png", { type: "image/png" });
    const prepared = {
      adapted: {
        markdown: [
          "# 标题",
          "",
          "正文。",
          "",
          "```bash",
          "pnpm test",
          "```",
          "",
          "![scene](images/scene.png)",
        ].join("\n"),
        adaptations: [],
        warnings: [],
      },
      parseResult: {
        title: "标题",
        coverImage: null,
        contentImages: [{ path: "images/scene.png", alt: "scene", blockIndex: 2, afterText: "pnpm test" }],
        contentCodeBlocks: [{ code: "pnpm test", language: "bash", blockIndex: 1, afterText: "正文。" }],
        dividers: [],
        html: "<p>正文。</p>",
        htmlBlocks: ["<p>正文。</p>"],
        totalBlocks: 1,
      },
      mediaRegistry: {
        resolveMediaPath: (source: string) => source,
        getUploadable: (path: string) => (path === "images/scene.png" ? imageFile : undefined),
      },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const payload = await buildMainWorldWritePayload(prepared);

    expect(payload.blocks.some((block) => block.text.includes("__YT2X_"))).toBe(true);
    expect(payload.plan.some((item) => item.op.type === "atomic" && item.op.entityType === "MARKDOWN")).toBe(
      true,
    );
    expect(payload.plan.some((item) => item.op.type === "image")).toBe(true);
    expect(payload.imageFiles).toHaveLength(1);
    expect(payload.imageFiles[0]?.fileName).toBe("scene.png");
  });

  it("does not duplicate the document title as the first body heading", async () => {
    const prepared = {
      adapted: {
        markdown: "# 标题\n\n正文。",
        adaptations: [],
        warnings: [],
      },
      parseResult: {
        title: "标题",
        coverImage: null,
        contentImages: [],
        contentCodeBlocks: [],
        dividers: [],
        html: "<p>正文。</p>",
        htmlBlocks: ["<p>正文。</p>"],
        totalBlocks: 1,
      },
      mediaRegistry: {
        resolveMediaPath: (source: string) => source,
        getUploadable: () => undefined,
      },
      generatedBlobs: new Map(),
    } as unknown as PreparedArticleImport;

    const payload = await buildMainWorldWritePayload(prepared);

    expect(payload.title).toBe("标题");
    expect(payload.blocks).toEqual([
      { type: "unstyled", text: "正文。", inlineStyleRanges: [], links: [] },
    ]);
    expect(payload.html).toBe("<p>正文。</p>");
    expect(payload.plain).toBe("正文。");
  });
});
