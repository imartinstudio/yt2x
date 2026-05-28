import { describe, expect, it } from "vitest";
import { prepareArticleImport } from "./prepare-import.js";
import type { MediaRegistry } from "./local-media.js";

describe("prepareArticleImport", () => {
  it("pastes code blocks directly while omitting dividers and native structural inserts", async () => {
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
        "```text",
        "Create a new GitHub repository for this project.",
        "```",
        "",
        "---",
        "",
        "尾段。",
      ].join("\n"),
      subscriptionTier: "premium",
      mediaRegistry,
    });

    expect(prepared.parseResult.contentCodeBlocks).toEqual([]);
    expect(prepared.parseResult.dividers).toEqual([]);
    expect(prepared.parseResult.html).toContain("<pre><code>Create a new GitHub repository");
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
});
