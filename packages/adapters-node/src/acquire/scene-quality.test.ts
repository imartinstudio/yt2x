import { describe, expect, it } from "vitest";
import { quickQualityFallback } from "./scene-quality.js";

describe("quickQualityFallback", () => {
  it("returns unusable by default", () => {
    const q = quickQualityFallback();
    expect(q.usable_for_content).toBe(false);
  });

  it("returns blur: unknown", () => {
    const q = quickQualityFallback();
    expect(q.blur).toBe("unknown");
  });

  it("returns center_presenter: false (MVP保守)", () => {
    const q = quickQualityFallback();
    expect(q.center_presenter).toBe(false);
  });

  it("returns has_text: false and has_ui: false", () => {
    const q = quickQualityFallback();
    expect(q.has_text).toBe(false);
    expect(q.has_ui).toBe(false);
  });
});
