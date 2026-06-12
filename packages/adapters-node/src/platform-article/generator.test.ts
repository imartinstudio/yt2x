import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { generatePlatformArticleContent, parseGeneratedPlatformArticleJson } from "./generator.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes",
  metadata: { id: "vid", title: "Hello" },
};

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

const xiaohongshuJson = JSON.stringify({
  target: "xiaohongshu",
  title: "t1",
  body: "body",
  tags: ["tag1", "tag2", "tag3"],
  cover: { headline: "h", subhead: "s", visual_prompt: "v" },
});

describe("generatePlatformArticleContent", () => {
  it("sends platform prompt and parses JSON", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/小红书/);
      expect(req.messages[0]!.content).toMatch(/3-5 个核心标签/);
      expect(req.messages[1]!.content).toMatch(/Source article\.md/);
      expect(req.temperature).toBeCloseTo(0.5);
      return { content: xiaohongshuJson, model: "m", finishReason: "stop" };
    });
    const result = await generatePlatformArticleContent({
      llm,
      model: "m",
      target: "xiaohongshu",
      artifacts: fakeArtifacts,
      articleMd: "# Article\n\nBody",
    });
    expect(result.platformArticle.target).toBe("xiaohongshu");
    expect(result.videoId).toBe("vid");
  });
});

describe("parseGeneratedPlatformArticleJson", () => {
  it("accepts json fence wrappers", () => {
    expect(parseGeneratedPlatformArticleJson("```json\n" + xiaohongshuJson + "\n```", "xiaohongshu").target)
      .toBe("xiaohongshu");
  });

  it("rejects target mismatches", () => {
    expect(() => parseGeneratedPlatformArticleJson(xiaohongshuJson, "wechat")).toThrow(/does not match/);
  });

  it("rejects invalid JSON responses clearly", () => {
    expect(() => parseGeneratedPlatformArticleJson("not json", "bilibili")).toThrow(/not valid JSON/);
  });
});
