import { describe, expect, it } from "vitest";
import {
  SHARED_JSON_BASE,
  SHARED_LANG_ZH_CN,
  SHARED_TECHNICAL_TERMS,
  SHARED_X_BASE,
} from "./shared-rules.js";

describe("shared technical term rules", () => {
  it("keeps shared rules generic and leaves active terms to the caller", () => {
    for (const prompt of [SHARED_TECHNICAL_TERMS, SHARED_LANG_ZH_CN, SHARED_X_BASE, SHARED_JSON_BASE]) {
      expect(prompt).toContain("运行时会追加本次源材料的 active terms");
      expect(prompt).not.toContain("Prompt Engineering");
      expect(prompt).not.toContain("Graph Engineering");
      expect(prompt).not.toContain("中央目录当前覆盖");
    }
  });

  it("uses generic catalog-driven terminology language", () => {
    expect(SHARED_TECHNICAL_TERMS).toContain("源材料中实际出现的术语");
    expect(SHARED_TECHNICAL_TERMS).not.toContain("尤其是 Prompt Engineering");
  });
});
