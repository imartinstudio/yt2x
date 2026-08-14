import { describe, expect, it } from "vitest";
import type { ChatRequest, LlmPort } from "@yt2x/core";
import type { StructuredNotesArtifacts } from "../article/file-store.js";
import {
  extractJsonStringField,
  parseJsonWithRepairs,
  stripJsonFenceWrapper,
} from "../llm/parse-json.js";
import { generateXVideoShortContent, parseGeneratedVideoShortPostJson } from "./generator.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point",
  metadata: { id: "vid", title: "Hello" },
};

describe("generateXVideoShortContent", () => {
  it("recovers catalog terms in video-short JSON without demanding the discovered term", async () => {
    const responses = [
      JSON.stringify({ text: "提示工程、上下文工程和图工程连接知识图谱与代理图谱，潜在工作区路由也很重要。图片和图表。" }),
      JSON.stringify({ text: "Prompt Engineering、Context Engineering 和 Graph Engineering 连接 Knowledge Graph 与 Agent Graph，Latent Workspace Routing 也很重要。图片和图表。" }),
    ];
    const llm: LlmPort = {
      chat: async (req) => req.messages[0]!.content.includes("术语发现器")
        ? { content: JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]), model: "m", finishReason: "stop" }
        : { content: responses.shift()!, model: "m", finishReason: "stop" },
    };
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "video-short-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateXVideoShortContent({ llm, model: "task3-video-short", artifacts });

    expect(result.videoShortPost.text).toContain("Prompt Engineering");
    expect(result.videoShortPost.text).toContain("Knowledge Graph");
    expect(result.videoShortPost.text).toContain("图片和图表");
    expect(result.videoShortPost.text).not.toContain("提示工程");
    // 发现词只保护不强制
    expect(result.videoShortPost.text).toContain("潜在工作区路由");
  });

  it("requests a bounded non-thinking JSON completion", async () => {
    const llm: LlmPort = {
      chat: async (req: ChatRequest) => {
        if (req.messages[0]!.content.includes("术语发现器")) {
          return { content: "[]", model: "deepseek-v4-pro", finishReason: "stop" };
        }
        expect(req.reasoningMode).toBe("disabled");
        expect(req.jsonMode).toBe(true);
        expect(req.maxTokens).toBe(2048);
        return {
          content: JSON.stringify({ text: "可直接发布的视频短帖" }),
          model: "deepseek-v4-pro",
          finishReason: "stop",
        };
      },
    };

    const result = await generateXVideoShortContent({
      llm,
      model: "deepseek-v4-pro",
      artifacts: fakeArtifacts,
    });

    expect(result.videoShortPost.text).toBe("可直接发布的视频短帖");
  });

  it("preserves technical terms in the video short caption", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "图工程（Graph Engineering）\n知识图谱（Knowledge Graph）\n代理图谱（Agent Graph）",
      metadata: { id: "vid", title: "Why Graph Engineering" },
    };
    const llm: LlmPort = {
      chat: async (req) => req.messages[0]!.content.includes("术语发现器")
        ? { content: "[]", model: "m", finishReason: "stop" }
        : {
          content: JSON.stringify({ text: "图工程把知识图谱和代理图谱连接起来。" }),
          model: "m",
          finishReason: "stop",
        },
    };

    const result = await generateXVideoShortContent({ llm, model: "m", artifacts });

    expect(result.videoShortPost.text).toBe("Graph Engineering 把 Knowledge Graph 和 Agent Graph 连接起来。");
  });
});

describe("parseGeneratedVideoShortPostJson", () => {
  it("accepts json fence wrappers", () => {
    const payload = JSON.stringify({ text: "第一段\n\n第二段\n\n完整视频+中文字幕：👇" });
    expect(parseGeneratedVideoShortPostJson("```json\n" + payload + "\n```").text).toContain("完整视频");
  });

  it("salvages text when the model emits unescaped quotes inside the string", () => {
    const raw = '{"text": "他说 "Claude Cowork" 很有用\n\n完整视频+中文字幕：👇"}';
    expect(parseGeneratedVideoShortPostJson(raw).text).toContain("Claude Cowork");
  });

  it("salvages text when json is truncated before the closing quote", () => {
    const raw = '{"text": "钩子段落\\n\\n观点段落\\n\\n总结段';
    expect(parseGeneratedVideoShortPostJson(raw).text).toContain("钩子段落");
  });
});

describe("parseJsonWithRepairs", () => {
  it("removes trailing commas before closing braces", () => {
    expect(parseJsonWithRepairs('{"text":"ok",}')).toEqual({ text: "ok" });
  });

  it("extracts the outer object when extra prose surrounds json", () => {
    const parsed = parseJsonWithRepairs('Here is JSON:\n{"text":"ok"}\nThanks.');
    expect(parsed).toEqual({ text: "ok" });
  });
});

describe("extractJsonStringField", () => {
  it("reads escaped newlines from a broken payload", () => {
    const raw = String.raw`{"text": "第一行\n\n第二行"}`;
    expect(extractJsonStringField(raw, "text")).toBe("第一行\n\n第二行");
  });

  it("returns null when the field is missing", () => {
    expect(extractJsonStringField(stripJsonFenceWrapper('{"title":"x"}'), "text")).toBeNull();
  });
});
