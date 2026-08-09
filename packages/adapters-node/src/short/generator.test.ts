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
  discoveryResponse = "[]",
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(
  req.messages[0]?.content.includes("术语发现器")
    ? { content: discoveryResponse, model: "m", finishReason: "stop" }
    : respond(req),
)) });

describe("generateXShortContent", () => {
  it("guards short-post JSON and repairs catalog plus discovered terms once", async () => {
    const responses = [
      JSON.stringify({ text: "提示工程、上下文工程和图工程连接知识图谱与代理图谱，潜在工作区路由也有用。图片和图表。", angle: "technical", risk: "low" }),
      JSON.stringify({ text: "Prompt Engineering、Context Engineering 和 Graph Engineering 连接 Knowledge Graph 与 Agent Graph，Latent Workspace Routing 也有用。图片和图表。", angle: "technical", risk: "low" }),
    ];
    const llm = makeLlm(
      () => ({ content: responses.shift()!, model: "m", finishReason: "stop" }),
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "short-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateXShortContent({ llm, model: "task3-short", artifacts });

    expect(result.shortPost.text).toContain("Prompt Engineering");
    expect(result.shortPost.text).toContain("Latent Workspace Routing");
    expect(result.shortPost.text).toContain("图片和图表");
    expect(result.shortPost.text).not.toContain("提示工程");
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

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

  it("preserves technical terms in the short post text", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "图工程（Graph Engineering）\n知识图谱（Knowledge Graph）\n代理图谱（Agent Graph）",
      metadata: { id: "vid", title: "Why Graph Engineering" },
    };
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        text: "图工程的核心不是更大的图，而是知识图谱和代理图谱的分工。",
        angle: "technical",
        risk: "low",
      }),
      model: "m",
      finishReason: "stop",
    }));

    const result = await generateXShortContent({ llm, model: "m", artifacts });

    expect(result.shortPost.text).toBe(
      "Graph Engineering 的核心不是更大的图，而是 Knowledge Graph 和 Agent Graph 的分工。",
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
