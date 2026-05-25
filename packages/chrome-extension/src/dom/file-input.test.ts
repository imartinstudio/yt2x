import { describe, expect, it } from "vitest";
import { normalizeUploadFile } from "./file-input.js";

describe("file-input", () => {
  it("fills missing video mime types", () => {
    const file = normalizeUploadFile(new File(["mp4"], "clip.mp4"));
    expect(file.type).toBe("video/mp4");
  });
});
