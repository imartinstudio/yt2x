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

    expect(llm.chat).toHaveBeenCalledTimes(2);
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
