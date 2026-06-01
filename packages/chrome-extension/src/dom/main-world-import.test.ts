import { describe, expect, it } from "vitest";
import { INJECT_DRAFT_WRITER_MESSAGE } from "../shared/main-world-messages.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("main-world import message contract", () => {
  it("keeps background and content inject message types aligned", () => {
    expect(INJECT_DRAFT_WRITER_MESSAGE).toBe("yt2x:inject-draft-writer");
  });

  it("bundles a local inject request constant in the content script", () => {
    const bundlePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../dist/content/x-articles.js",
    );
    const bundle = readFileSync(bundlePath, "utf8");
    expect(bundle).toContain('INJECT_DRAFT_WRITER_REQUEST = "yt2x:inject-draft-writer"');
    expect(bundle).toContain('type: INJECT_DRAFT_WRITER_REQUEST');
    expect(bundle).not.toMatch(/type:\s*INJECT_DRAFT_WRITER_MESSAGE\b/);
  });
});
