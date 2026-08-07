import { describe, expect, it } from "vitest";
import { DECONSTRUCT_SYSTEM_PROMPT } from "./prompts.js";

describe("DECONSTRUCT_SYSTEM_PROMPT", () => {
  it("preserves technical terms in candidate metadata", () => {
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Prompt Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Context Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Graph Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Knowledge Graph");
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Agent Graph");
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("Graph 的基本词汇");
  });
});
