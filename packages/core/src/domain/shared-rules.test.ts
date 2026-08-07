import { describe, expect, it } from "vitest";
import {
  SHARED_JSON_BASE,
  SHARED_LANG_ZH_CN,
  SHARED_TECHNICAL_TERMS,
  SHARED_X_BASE,
} from "./shared-rules.js";

describe("shared technical term rules", () => {
  it("protects named engineering concepts and standalone Graph usage", () => {
    for (const prompt of [SHARED_TECHNICAL_TERMS, SHARED_LANG_ZH_CN, SHARED_X_BASE, SHARED_JSON_BASE]) {
      expect(prompt).toContain("Prompt Engineering");
      expect(prompt).toContain("Context Engineering");
      expect(prompt).toContain("Graph Engineering");
      expect(prompt).toContain("Knowledge Graph");
      expect(prompt).toContain("Agent Graph");
      expect(prompt).toContain("Graph 的基本词汇");
      expect(prompt).toContain("不得只写");
    }
  });
});
