import { describe, expect, it } from "vitest";
import { adaptArticleForX } from "./article-for-x.js";

describe("adaptArticleForX", () => {
  it("flattens deep headings and preserves uploadable HTML video for X Premium", () => {
    const adapted = adaptArticleForX({
      markdown: "# Title\n\n### **Detail**\n\n<video controls src=\"video/clip.mp4\"></video>\n",
      subscriptionTier: "premium",
      sourceVideoUrl: "<YOUTUBE_URL>",
    });

    expect(adapted.markdown).toContain("**Detail**");
    expect(adapted.markdown).toContain('<video controls src="video/clip.mp4"></video>');
    expect(adapted.adaptations.map((item) => item.kind)).toEqual(["deep-heading"]);
  });

  it("keeps H3 and tables for Premium Plus", () => {
    const adapted = adaptArticleForX({
      markdown: "### Detail\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      subscriptionTier: "premium-plus",
    });

    expect(adapted.markdown).toContain("### Detail");
    expect(adapted.markdown).toContain("| 1 | 2 |");
    expect(adapted.adaptations).toEqual([]);
  });

  it("creates Premium table image placeholders and leaves a warning for Mermaid conversion", () => {
    const adapted = adaptArticleForX({
      markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart LR\nA-->B\n```\n",
      subscriptionTier: "premium",
    });

    expect(adapted.markdown).toContain("![Table](yt2x-table-1.png)");
    expect(adapted.markdown).toContain("Mermaid diagram requires image conversion");
    expect(adapted.adaptations).toContainEqual(
      expect.objectContaining({
        kind: "premium-table",
        placeholder: "yt2x-table-1.png",
      }),
    );
    expect(adapted.warnings).toHaveLength(1);
  });

  it("warns when Markdown images are nested inside lists", () => {
    const adapted = adaptArticleForX({
      markdown: "- ![shot](images/shot.png)\n",
      subscriptionTier: "premium",
    });

    expect(adapted.warnings).toEqual(["Images inside Markdown lists need manual review before X Articles insertion."]);
  });
});
