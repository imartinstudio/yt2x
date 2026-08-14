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
  it("recovers catalog terms in short-post JSON without demanding the discovered term", async () => {
    const llm = makeLlm(
      () => ({
        content: JSON.stringify({ text: "提示工程、上下文工程和图工程连接知识图谱与代理图谱，潜在工作区路由也有用。图片和图表。", angle: "technical", risk: "low" }),
        model: "m",
        finishReason: "stop",
      }),
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "short-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateXShortContent({ llm, model: "task3-short", artifacts });

    expect(result.shortPost.text).toContain("Prompt Engineering");
    expect(result.shortPost.text).toContain("Knowledge Graph");
    expect(result.shortPost.text).toContain("图片和图表");
    expect(result.shortPost.text).not.toContain("提示工程");
    // 发现词只保护不强制
    expect(result.shortPost.text).toContain("潜在工作区路由");
    expect(llm.chat).toHaveBeenCalledTimes(2);
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

  it("validates what actually ships: a removed visual's caption cannot fail the post", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Graph Engineering 是这里必须保留的专业术语。",
      metadata: { id: "short-final-validation", title: "Graph Engineering" },
    };
    // 无效 visual 会被摘掉，它 caption 里的禁用译法不该连累正文
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        text: "这里只保留普通正文。",
        angle: "technical",
        risk: "low",
        visual: { visual_id: "missing-visual", caption: "图工程" },
      }),
      model: "m",
      finishReason: "stop",
    }));

    const result = await generateXShortContent({ llm, model: "m", artifacts, availableVisuals: [] });

    expect(result.shortPost.visual).toBeUndefined();
    expect(result.shortPost.text).toBe("这里只保留普通正文。");
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("allows a summary to omit terms that are only in an unselected detailed source section", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: [
        "# Notes",
        "",
        "## Executive Summary",
        "Graph Engineering is the core idea.",
        "",
        "## Detailed Notes",
        "Knowledge Graph is an implementation detail that this summary does not discuss.",
      ].join("\n"),
      metadata: { id: "short-summary-scope", title: "Graph Engineering" },
    };
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        text: "Graph Engineering 是核心判断。",
        angle: "technical",
        risk: "low",
      }),
      model: "m",
      finishReason: "stop",
    }));

    await expect(generateXShortContent({ llm, model: "m", artifacts })).resolves.toMatchObject({
      shortPost: { text: expect.stringContaining("Graph Engineering") },
    });
  });

  it("repairs a translated term inside the selected summary scope", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: [
        "# Notes",
        "",
        "## Executive Summary",
        "Graph Engineering is the core idea.",
        "",
        "## Detailed Notes",
        "Knowledge Graph is an implementation detail.",
      ].join("\n"),
      metadata: { id: "short-summary-translation", title: "Graph Engineering" },
    };
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        text: "图工程是核心判断。",
        angle: "technical",
        risk: "low",
      }),
      model: "m",
      finishReason: "stop",
    }));

    await expect(generateXShortContent({ llm, model: "m", artifacts })).resolves.toMatchObject({
      shortPost: { text: expect.stringContaining("Graph Engineering") },
    });
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
