import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INJECT_DRAFT_WRITER_MESSAGE } from "../shared/main-world-messages.js";

describe("main-world import message contract", () => {
  it("keeps background and content inject message types aligned", () => {
    expect(INJECT_DRAFT_WRITER_MESSAGE).toBe("yt2x:inject-draft-writer");
  });

  it("uses a local inject request constant when messaging the background worker", () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "main-world-import.ts");
    const source = readFileSync(sourcePath, "utf8");
    expect(source).toContain('const INJECT_DRAFT_WRITER_REQUEST = "yt2x:inject-draft-writer"');
    expect(source).toContain("type: INJECT_DRAFT_WRITER_REQUEST");
    expect(source).not.toMatch(/type:\s*INJECT_DRAFT_WRITER_MESSAGE\b/);
  });
});
