import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { generateXShortContent, parseGeneratedShortPostJson } from "./generator.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point",
  metadata: { id: "vid", title: "Hello" },
};

const shortJson = JSON.stringify({
  text: "one useful short post",
  angle: "practical",
  risk: "low",
});

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

describe("generateXShortContent", () => {
  it("sends short system prompt and parses JSON", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[0]!.content).toMatch(/只生成 1 条短帖正文/);
      expect(req.messages[0]!.content).toMatch(/内容总结 list/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: shortJson, model: "m", finishReason: "stop" };
    });
    const result = await generateXShortContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(result.shortPost.text).toBe("one useful short post");
    expect(result.videoId).toBe("vid");
  });

  it("rejects invalid JSON responses clearly", async () => {
    const llm = makeLlm(() => ({ content: "not json", model: "m", finishReason: "stop" }));
    await expect(generateXShortContent({ llm, model: "m", artifacts: fakeArtifacts })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("parseGeneratedShortPostJson", () => {
  it("accepts json fence wrappers", () => {
    expect(parseGeneratedShortPostJson("```json\n" + shortJson + "\n```").text).toBe(
      "one useful short post",
    );
  });

  it("rejects schema mismatches clearly", () => {
    expect(() => parseGeneratedShortPostJson(JSON.stringify({ text: "x", angle: "bad", risk: "low" }))).toThrow(
      /expected schema/,
    );
  });

  it("rejects markdown tables in generated short posts", () => {
    expect(() =>
      parseGeneratedShortPostJson(
        JSON.stringify({
          text: "**核心：**\n| A | B |\n| --- | --- |\n| ok | yes |",
          angle: "practical",
          risk: "low",
        }),
      ),
    ).toThrow(/contains a markdown table/);
  });
});
