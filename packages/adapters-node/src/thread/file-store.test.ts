import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderXThreadMarkdown, writeNativeThreadBundle } from "./file-store.js";

let articleRoot: string;

const thread = {
  title: "Thread title",
  planning: {
    core_thesis: "core",
    conflict: "conflict",
    key_points: ["p1", "p2", "p3", "p4"],
    reader_gain: "gain",
    final_post: "final",
  },
  tweets: ["判断：first", "收益：second"],
  hooks: [
    { text: "h1", angle: "反直觉", risk: "low" as const },
    { text: "h2", angle: "实用收益", risk: "medium" as const },
    { text: "h3", angle: "技术洞察", risk: "high" as const },
  ],
};

beforeEach(async () => {
  articleRoot = await mkdtemp(path.join(tmpdir(), "yt2x-thread-out-"));
});

afterEach(async () => {
  await rm(articleRoot, { recursive: true, force: true });
});

describe("renderXThreadMarkdown", () => {
  it("renders numbered thread markdown", () => {
    expect(renderXThreadMarkdown(thread)).toBe("1/ 判断：first\n\n2/ 收益：second\n");
  });
});

describe("writeNativeThreadBundle", () => {
  it("writes x-thread.md and x-hooks.json", async () => {
    const written = await writeNativeThreadBundle(articleRoot, "v1", thread);
    expect(await readFile(written.threadPath, "utf8")).toBe(
      "1/ 判断：first\n\n2/ 收益：second\n",
    );
    const hooks = JSON.parse(await readFile(written.hooksPath, "utf8")) as { hooks: unknown[] };
    expect(hooks.hooks).toHaveLength(3);
  });

  it("refuses overwrite without --force", async () => {
    await writeNativeThreadBundle(articleRoot, "v1", thread);
    await expect(writeNativeThreadBundle(articleRoot, "v1", thread)).rejects.toThrow(/already exists/);
  });
});
