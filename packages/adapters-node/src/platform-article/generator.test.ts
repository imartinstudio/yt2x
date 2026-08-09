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
  discoveryResponse = "[]",
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(
  req.messages[0]?.content.includes("术语发现器")
    ? { content: discoveryResponse, model: "m", finishReason: "stop" }
    : respond(req),
)) });

const xiaohongshuJson = JSON.stringify({
  target: "xiaohongshu",
  title: "t1",
  body: "body",
  tags: ["tag1", "tag2", "tag3"],
  cover: { headline: "h", subhead: "s", visual_prompt: "v" },
});

describe("generatePlatformArticleContent", () => {
  it("guards all nested platform article fields and repairs once", async () => {
    const responses = [
      JSON.stringify({
        target: "xiaohongshu",
        title: "提示工程和图工程",
        body: "上下文工程连接知识图谱与代理图谱，也包含潜在工作区路由。",
        tags: ["图工程", "知识图谱", "代理图谱"],
        cover: { headline: "图工程", subhead: "知识图谱", visual_prompt: "图片、图表和图文" },
      }),
      JSON.stringify({
        target: "xiaohongshu",
        title: "Prompt Engineering 和 Graph Engineering",
        body: "Context Engineering 连接 Knowledge Graph 与 Agent Graph，也包含 Latent Workspace Routing。",
        tags: ["Graph Engineering", "Knowledge Graph", "Agent Graph"],
        cover: { headline: "Graph Engineering", subhead: "Knowledge Graph", visual_prompt: "图片、图表和图文" },
      }),
    ];
    const llm = makeLlm(
      () => ({ content: responses.shift()!, model: "m", finishReason: "stop" }),
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "platform-term-guard", title: "Prompt Engineering" },
    };

    const result = await generatePlatformArticleContent({
      llm,
      model: "task3-platform",
      target: "xiaohongshu",
      artifacts,
      articleMd: "# Prompt Engineering\n\nGraph Engineering 与 Latent Workspace Routing。",
    });

    expect(JSON.stringify(result.platformArticle)).toContain("Prompt Engineering");
    expect(JSON.stringify(result.platformArticle)).toContain("Latent Workspace Routing");
    expect(JSON.stringify(result.platformArticle)).toContain("图片、图表和图文");
    expect(JSON.stringify(result.platformArticle)).not.toContain("提示工程");
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

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

  it("preserves technical terms in every platform article text field", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "图工程（Graph Engineering）\n知识图谱（Knowledge Graph）\n代理图谱（Agent Graph）",
      metadata: { id: "vid", title: "Why Graph Engineering" },
    };
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        target: "xiaohongshu",
        title: "图工程入门",
        body: "知识图谱和代理图谱的区别。",
        tags: ["图工程", "知识图谱", "工作流"],
        cover: { headline: "图工程", subhead: "代理图谱", visual_prompt: "展示图工程" },
      }),
      model: "m",
      finishReason: "stop",
    }));

    const result = await generatePlatformArticleContent({
      llm,
      model: "m",
      target: "xiaohongshu",
      artifacts,
      articleMd: "# Graph Engineering\n\n正文",
    });

    expect(result.platformArticle).toMatchObject({
      title: "Graph Engineering 入门",
      body: "Knowledge Graph 和 Agent Graph 的区别。",
      tags: ["Graph Engineering", "Knowledge Graph", "工作流"],
      cover: {
        headline: "Graph Engineering",
        subhead: "Agent Graph",
        visual_prompt: "展示 Graph Engineering",
      },
    });
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

  it("recovers from prose and control characters around the JSON", () => {
    const withStrayNewline = xiaohongshuJson.replace('"body":"body"', '"body":"line1\nline2"');
    const parsed = parseGeneratedPlatformArticleJson(
      `好的，以下是结果：\n${withStrayNewline}\n`,
      "xiaohongshu",
    );
    expect(parsed.target).toBe("xiaohongshu");
    expect(parsed.body).toBe("line1\nline2");
  });
});

/**
 * Regression: a wechat response omitted the comma after the long `body` value,
 * so `JSON.parse` failed with "Expected ',' or '}' after property value" and the
 * whole article stage aborted. Repairs cannot safely re-insert a structural comma
 * into published article text, so the generator asks the model once more instead.
 */
describe("generatePlatformArticleContent invalid-JSON recovery", () => {
  const wechatArticle = {
    target: "wechat" as const,
    title: "统一主标题",
    title_options: ["备选一", "备选二", "备选三"],
    summary: "摘要",
    lead: "导语",
    body: "## 小节\n\n正文内容。",
    cover: { headline: "封面标题", subhead: "副标题", visual_prompt: "设计说明" },
  };
  const wechatJson = JSON.stringify(wechatArticle, null, 2);
  const missingComma = wechatJson.replace(/",\n {2}"cover"/, '"\n  "cover"');

  it("regenerates once when the first response is not valid JSON", async () => {
    const responses = [missingComma, wechatJson];
    const llm = makeLlm(() => ({
      content: responses.shift() ?? "",
      model: "m",
      finishReason: "stop",
    }));

    const result = await generatePlatformArticleContent({
      llm,
      model: "m",
      target: "wechat",
      artifacts: fakeArtifacts,
      articleMd: "# Article",
    });

    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(result.platformArticle.target).toBe("wechat");
    expect(result.platformArticle.title).toBe("统一主标题");
  });

  it("does not regenerate when the first response parses", async () => {
    const llm = makeLlm(() => ({ content: wechatJson, model: "m", finishReason: "stop" }));
    await generatePlatformArticleContent({
      llm,
      model: "m",
      target: "wechat",
      artifacts: fakeArtifacts,
      articleMd: "# Article",
    });
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("fails with the original parse error when the retry is also invalid", async () => {
    const llm = makeLlm(() => ({ content: missingComma, model: "m", finishReason: "stop" }));
    await expect(
      generatePlatformArticleContent({
        llm,
        model: "m",
        target: "wechat",
        artifacts: fakeArtifacts,
        articleMd: "# Article",
      }),
    ).rejects.toThrow(/not valid JSON/);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the response parses but violates the schema", async () => {
    const llm = makeLlm(() => ({
      content: JSON.stringify({ ...wechatArticle, title_options: [] }),
      model: "m",
      finishReason: "stop",
    }));
    await expect(
      generatePlatformArticleContent({
        llm,
        model: "m",
        target: "wechat",
        artifacts: fakeArtifacts,
        articleMd: "# Article",
      }),
    ).rejects.toThrow(/does not match expected schema/);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
});
