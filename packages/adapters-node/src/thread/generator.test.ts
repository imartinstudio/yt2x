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
  planning: {
    core_thesis: "core",
    conflict: "conflict",
    key_points: ["p1", "p2", "p3", "p4"],
    reader_gain: "gain",
    final_post: "final",
  },
  tweets: [
    "判断：t1",
    "误区：t2",
    "方法：t3",
    "验证：t4",
    "工具：t5",
    "收益：t6",
  ],
  hooks: [
    { text: "h1", angle: "反直觉", risk: "low" },
    { text: "h2", angle: "实用收益", risk: "low" },
    { text: "h3", angle: "技术洞察", risk: "medium" },
  ],
});

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
  discoveryResponse = "[]",
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(
  req.messages[0]?.content.includes("术语发现器")
    ? { content: discoveryResponse, model: "m", finishReason: "stop" }
    : respond(req),
)) });

describe("generateXThreadContent", () => {
  it("guards nested thread fields and repairs catalog plus discovered terms once", async () => {
    const responses = [
      JSON.stringify({
        title: "图工程线程",
        planning: { core_thesis: "提示工程", conflict: "上下文工程", key_points: ["图工程", "知识图谱", "代理图谱", "术语：潜在工作区路由"], reader_gain: "图片和图表", final_post: "图文总结" },
        tweets: ["图工程", "知识图谱", "代理图谱", "术语：潜在工作区路由", "图片", "图文"],
        hooks: [
          { text: "提示工程", angle: "反直觉", risk: "low" },
          { text: "上下文工程", angle: "实用收益", risk: "low" },
          { text: "图工程", angle: "技术洞察", risk: "medium" },
        ],
      }),
      JSON.stringify({
        title: "Graph Engineering 线程",
        planning: { core_thesis: "Prompt Engineering", conflict: "Context Engineering", key_points: ["Graph Engineering", "Knowledge Graph", "Agent Graph", "术语：Latent Workspace Routing"], reader_gain: "图片和图表", final_post: "图文总结" },
        tweets: ["Graph Engineering", "Knowledge Graph", "Agent Graph", "术语：Latent Workspace Routing", "图片", "图文"],
        hooks: [
          { text: "Prompt Engineering", angle: "反直觉", risk: "low" },
          { text: "Context Engineering", angle: "实用收益", risk: "low" },
          { text: "Graph Engineering", angle: "技术洞察", risk: "medium" },
        ],
      }),
    ];
    const llm = makeLlm(
      () => ({ content: responses.shift()!, model: "m", finishReason: "stop" }),
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "thread-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateXThreadContent({ llm, model: "task3-thread", artifacts });

    expect(JSON.stringify(result.thread)).toContain("Prompt Engineering");
    expect(JSON.stringify(result.thread)).toContain("Latent Workspace Routing");
    expect(JSON.stringify(result.thread)).toContain("图片和图表");
    expect(JSON.stringify(result.thread)).not.toContain("提示工程");
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it("sends thread system prompt and parses JSON", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[0]!.content).toMatch(/6–8/);
      expect(req.messages[0]!.content).toMatch(/500 字符/);
      expect(req.messages[0]!.content).toMatch(/压缩表达或与相邻观点合并/);
      expect(req.messages[0]!.content).toMatch(/core_thesis/);
      expect(req.messages[0]!.content).toMatch(/内容本身提炼出的短标题/);
      expect(req.messages[0]!.content).toMatch(/tweets 字段内部也不要包含 Markdown 格式/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: threadJson, model: "m", finishReason: "stop" };
    });
    const result = await generateXThreadContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(result.thread.title).toBe("Thread title");
    expect(result.thread.planning.key_points).toHaveLength(4);
    expect(result.thread.tweets).toHaveLength(6);
    expect(result.videoId).toBe("vid");
  });

  it("rejects invalid JSON responses clearly", async () => {
    const llm = makeLlm(() => ({ content: "not json", model: "m", finishReason: "stop" }));
    await expect(generateXThreadContent({ llm, model: "m", artifacts: fakeArtifacts })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("preserves technical terms in planning, tweets, hooks, and title", async () => {
    const artifacts: StructuredNotesArtifacts = {
      ...fakeArtifacts,
      structuredNotesMd: "图工程（Graph Engineering）\n知识图谱（Knowledge Graph）\n代理图谱（Agent Graph）",
      metadata: { id: "vid", title: "Why Graph Engineering" },
    };
    const llm = makeLlm(() => ({
      content: JSON.stringify({
        title: "为什么图工程值得使用",
        planning: {
          core_thesis: "图工程让工作流可检查",
          conflict: "知识图谱和代理图谱经常被混淆",
          key_points: ["图工程", "知识图谱", "代理图谱", "可检查"],
          reader_gain: "学会构建图",
          final_post: "从第一个图开始",
        },
        tweets: ["图工程", "知识图谱", "代理图谱", "什么时候值得用图", "更大的图", "第一个图"],
        hooks: [
          { text: "图工程不是画图", angle: "反直觉", risk: "low" },
          { text: "知识图谱不是代理图谱", angle: "争议判断", risk: "low" },
          { text: "第一个图应该很小", angle: "技术洞察", risk: "medium" },
        ],
      }),
      model: "m",
      finishReason: "stop",
    }));

    const result = await generateXThreadContent({ llm, model: "m", artifacts });

    expect(result.thread.title).toContain("Graph Engineering");
    expect(result.thread.planning.core_thesis).toContain("Graph Engineering");
    expect(result.thread.tweets).toEqual([
      "Graph Engineering",
      "Knowledge Graph",
      "Agent Graph",
      "什么时候值得用 Graph",
      "更大的 Graph",
      "第一个 Graph",
    ]);
    expect(result.thread.hooks[0]?.text).toContain("Graph Engineering");
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

  it("does not add fallback labels to tweets without short labels", () => {
    const raw = JSON.stringify({
      title: "Thread title",
      planning: {
        core_thesis: "core",
        conflict: "conflict",
        key_points: ["p1", "p2", "p3", "p4"],
        reader_gain: "gain",
        final_post: "final",
      },
      tweets: ["plain t1", "误区：t2", "方法：t3", "验证：t4", "工具：t5", "收益：t6"],
      hooks: [
        { text: "h1", angle: "反直觉", risk: "low" },
        { text: "h2", angle: "实用收益", risk: "low" },
        { text: "h3", angle: "技术洞察", risk: "medium" },
      ],
    });
    expect(parseGeneratedThreadJson(raw).tweets[0]).toBe("plain t1");
  });

  it("normalizes extra planning key points without rejecting the thread", () => {
    const raw = JSON.stringify({
      title: "Thread title",
      planning: {
        core_thesis: "core",
        conflict: "conflict",
        key_points: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
        reader_gain: "gain",
        final_post: "final",
      },
      tweets: ["判断：t1", "误区：t2", "方法：t3", "验证：t4", "工具：t5", "收益：t6"],
      hooks: [
        { text: "h1", angle: "反直觉", risk: "low" },
        { text: "h2", angle: "实用收益", risk: "low" },
        { text: "h3", angle: "技术洞察", risk: "medium" },
      ],
    });

    expect(parseGeneratedThreadJson(raw).planning.key_points).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("strips template labels while preserving content-derived labels and markdown", () => {
    const raw = JSON.stringify({
      title: "Thread title",
      planning: {
        core_thesis: "core",
        conflict: "conflict",
        key_points: ["p1", "p2", "p3", "p4"],
        reader_gain: "gain",
        final_post: "final",
      },
      tweets: [
        "**核心公式：**Harness = Agent - Model",
        "**Codex 验证闭环：**用 `linter` 和截图自测",
        "关键方法：保留内容",
        "验证：t4",
        "工具：t5",
        "读者收益：知道怎么落地",
      ],
      hooks: [
        { text: "h1", angle: "反直觉", risk: "low" },
        { text: "h2", angle: "实用收益", risk: "low" },
        { text: "h3", angle: "技术洞察", risk: "medium" },
      ],
    });
    expect(parseGeneratedThreadJson(raw).tweets).toEqual([
      "Harness = Agent - Model",
      "**Codex 验证闭环：**用 `linter` 和截图自测",
      "保留内容",
      "验证：t4",
      "工具：t5",
      "知道怎么落地",
    ]);
  });

  it("rejects markdown tables in generated tweets", () => {
    const raw = JSON.stringify({
      title: "Thread title",
      planning: {
        core_thesis: "core",
        conflict: "conflict",
        key_points: ["p1", "p2", "p3", "p4"],
        reader_gain: "gain",
        final_post: "final",
      },
      tweets: [
        "判断：t1",
        "误区：t2",
        "方法：| A | B |\n| --- | --- |\n| ok | yes |",
        "验证：t4",
        "工具：t5",
        "收益：t6",
      ],
      hooks: [
        { text: "h1", angle: "反直觉", risk: "low" },
        { text: "h2", angle: "实用收益", risk: "low" },
        { text: "h3", angle: "技术洞察", risk: "medium" },
      ],
    });
    expect(() => parseGeneratedThreadJson(raw)).toThrow(/markdown table in tweets\[2\]/);
  });
});
