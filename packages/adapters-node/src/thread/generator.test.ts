import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import { generateXThreadContent, parseGeneratedThreadJson } from "./generator.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point",
  metadata: { id: "vid", title: "Hello" },
};

const threadJson = JSON.stringify({
  title: "Thread title",
  tweets: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"],
  hooks: [
    { text: "h1", angle: "反直觉", risk: "low" },
    { text: "h2", angle: "实用收益", risk: "low" },
    { text: "h3", angle: "技术洞察", risk: "medium" },
  ],
});

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

describe("generateXThreadContent", () => {
  it("sends thread system prompt and parses JSON", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[0]!.content).toMatch(/8–15/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: threadJson, model: "m", finishReason: "stop" };
    });
    const result = await generateXThreadContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(result.thread.title).toBe("Thread title");
    expect(result.thread.tweets).toHaveLength(8);
    expect(result.videoId).toBe("vid");
  });

  it("rejects invalid JSON responses clearly", async () => {
    const llm = makeLlm(() => ({ content: "not json", model: "m", finishReason: "stop" }));
    await expect(generateXThreadContent({ llm, model: "m", artifacts: fakeArtifacts })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("parseGeneratedThreadJson", () => {
  it("accepts json fence wrappers", () => {
    expect(parseGeneratedThreadJson("```json\n" + threadJson + "\n```").title).toBe("Thread title");
  });

  it("rejects schema mismatches clearly", () => {
    expect(() => parseGeneratedThreadJson(JSON.stringify({ title: "x", tweets: [], hooks: [] }))).toThrow(
      /expected schema/,
    );
  });
});
