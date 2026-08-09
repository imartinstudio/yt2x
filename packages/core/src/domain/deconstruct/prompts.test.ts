import { describe, expect, it } from "vitest";
import { DECONSTRUCT_SYSTEM_PROMPT } from "./prompts.js";

describe("DECONSTRUCT_SYSTEM_PROMPT", () => {
  it("defers source-active technical terms to the runtime profile", () => {
    expect(DECONSTRUCT_SYSTEM_PROMPT).toContain("运行时会追加本次源材料的 active terms");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Prompt Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Context Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Graph Engineering");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Knowledge Graph");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Agent Graph");
    expect(DECONSTRUCT_SYSTEM_PROMPT).not.toContain("Graph 的基本词汇");
  });
});
