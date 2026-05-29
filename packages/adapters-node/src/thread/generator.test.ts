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
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

describe("generateXThreadContent", () => {
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
