import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderXShortMarkdown, writeNativeShortBundle } from "./file-store.js";

let articleRoot: string;

const shortPost = {
  text: "one useful short post",
  angle: "practical" as const,
  risk: "low" as const,
};

beforeEach(async () => {
  articleRoot = await mkdtemp(path.join(tmpdir(), "yt2x-short-out-"));
});

afterEach(async () => {
  await rm(articleRoot, { recursive: true, force: true });
});

describe("renderXShortMarkdown", () => {
  it("renders one short post", () => {
    expect(renderXShortMarkdown(shortPost)).toBe("one useful short post\n");
  });

  it("preserves markdown formatting inside generated short posts", () => {
    expect(
      renderXShortMarkdown({
        ...shortPost,
        text: "**核心：**保留 `code`\n\n1. item\n\n```bash\npnpm test\n```",
      }),
    ).toBe("**核心：**保留 `code`\n\n1. item\n\n```bash\npnpm test\n```\n");
  });
});

describe("writeNativeShortBundle", () => {
  it("writes x-short.md", async () => {
    const written = await writeNativeShortBundle(articleRoot, "v1", shortPost);
    expect(await readFile(written.shortPath, "utf8")).toBe("one useful short post\n");
  });

  it("returns null when x-short.md exists without --force", async () => {
    await writeNativeShortBundle(articleRoot, "v1", shortPost);
    const result = await writeNativeShortBundle(articleRoot, "v1", shortPost);
    expect(result).toBeNull();
  });
});
