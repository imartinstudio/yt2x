import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import { generateNotesContent } from "./generator.js";
import type { VideoDirArtifacts } from "./file-store.js";

const fakeArtifacts: VideoDirArtifacts = {
  videoDir: "/tmp/abc",
  videoId: "abc",
  chunksMd: "## Chunk 1\nbody",
  timestampedCuesMd: "00:00 — hello",
  metadata: { id: "abc", title: "Hello" },
  screenshots: null,
};

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
  discoveryResponse = "[]",
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(
  req.messages[0]?.content.includes("术语发现器")
    ? { content: discoveryResponse, model: "m", finishReason: "stop" }
    : respond(req),
)) });

describe("generateNotesContent", () => {
  it("guards catalog and discovered terms with one targeted repair", async () => {
    const responses = [
      "# 标题\n\n提示工程、上下文工程和图工程会处理知识图谱与代理图谱；潜在工作区路由也很重要。图片、图表和图文不应误报。",
      "# Prompt Engineering\n\nPrompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph 和 Latent Workspace Routing 都必须保留。图片、图表和图文不应误报。",
    ];
    const llm = makeLlm(
      () => ({ content: responses.shift()!, model: "m", finishReason: "stop" }),
      JSON.stringify([{ sourceText: "Latent Workspace Routing", confidence: "high", category: "ai-agent" }]),
    );
    const artifacts: VideoDirArtifacts = {
      ...fakeArtifacts,
      chunksMd: "Prompt Engineering、Context Engineering、Graph Engineering、Knowledge Graph、Agent Graph、Latent Workspace Routing",
      metadata: { id: "notes-term-guard", title: "Prompt Engineering" },
    };

    const result = await generateNotesContent({ llm, model: "task3-notes", artifacts });

    expect(result.content).toContain("Prompt Engineering");
    expect(result.content).toContain("Latent Workspace Routing");
    expect(result.content).toContain("图片、图表和图文");
    expect(result.content).not.toContain("提示工程、上下文工程和图工程");
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it("sends a system + user message and returns trimmed content", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages).toHaveLength(2);
      expect(req.messages[0]!.role).toBe("system");
      expect(req.messages[1]!.role).toBe("user");
      expect(req.messages[1]!.content).toMatch(/## Metadata/);
      expect(req.messages[1]!.content).toMatch(/## Transcript Chunks/);
      return {
        content: "  # Title\n\nbody  ",
        model: "gpt-4o-mini",
        finishReason: "stop",
      };
    });
    const result = await generateNotesContent({
      llm,
      model: "gpt-4o-mini",
      artifacts: fakeArtifacts,
    });
    expect(result.content).toBe("# Title\n\nbody");
    expect(result.videoId).toBe("abc");
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.finishReason).toBe("stop");
  });

  it("strips ```markdown fence wrappers if LLM wraps the output", async () => {
    const llm = makeLlm(() => ({
      content: "```markdown\n# Title\n\nbody\n```",
      model: "x",
      finishReason: "stop",
    }));
    const result = await generateNotesContent({ llm, model: "x", artifacts: fakeArtifacts });
    expect(result.content).toBe("# Title\n\nbody");
  });

  it("strips plain ``` fence too", async () => {
    const llm = makeLlm(() => ({
      content: "```\n# Title\n\nbody\n```",
      model: "x",
      finishReason: "stop",
    }));
    const result = await generateNotesContent({ llm, model: "x", artifacts: fakeArtifacts });
    expect(result.content).toBe("# Title\n\nbody");
  });

  it("uses default temperature 0.3 and maxTokens 16384", async () => {
    const llm = makeLlm((req) => {
      expect(req.temperature).toBeCloseTo(0.3);
      expect(req.maxTokens).toBe(16384);
      return { content: "ok", model: "x", finishReason: "stop" };
    });
    await generateNotesContent({ llm, model: "x", artifacts: fakeArtifacts });
  });

  it("honors explicit temperature / maxTokens overrides", async () => {
    const llm = makeLlm((req) => {
      expect(req.temperature).toBe(0);
      expect(req.maxTokens).toBe(4096);
      return { content: "ok", model: "x", finishReason: "stop" };
    });
    await generateNotesContent({
      llm,
      model: "x",
      temperature: 0,
      maxTokens: 4096,
      artifacts: fakeArtifacts,
    });
  });

  it("forwards usage when provided", async () => {
    const llm = makeLlm(() => ({
      content: "ok",
      model: "x",
      finishReason: "stop",
      usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
    }));
    const result = await generateNotesContent({ llm, model: "x", artifacts: fakeArtifacts });
    expect(result.usage).toEqual({ promptTokens: 1000, completionTokens: 200, totalTokens: 1200 });
  });

  it("propagates AbortSignal to the LlmPort", async () => {
    const controller = new AbortController();
    const llm = makeLlm((req) => {
      expect(req.signal).toBe(controller.signal);
      return { content: "ok", model: "x", finishReason: "stop" };
    });
    await generateNotesContent({
      llm,
      model: "x",
      artifacts: fakeArtifacts,
      signal: controller.signal,
    });
  });

  it("propagates LLM errors unchanged (caller decides retry/exit)", async () => {
    const failing: LlmPort = {
      chat: vi.fn(() => Promise.reject(new Error("provider exploded"))),
    };
    await expect(
      generateNotesContent({ llm: failing, model: "x", artifacts: fakeArtifacts }),
    ).rejects.toThrow(/provider exploded/);
  });
});
