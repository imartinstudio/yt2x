import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import { generateXArticleContent } from "./generator.js";
import type { StructuredNotesArtifacts } from "./file-store.js";

const fakeArtifacts: StructuredNotesArtifacts = {
  videoDir: "/tmp/v",
  videoId: "vid",
  structuredNotesMd: "# Notes\n\n- point",
  metadata: { id: "vid", title: "Hello" },
};

const makeLlm = (
  respond: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): LlmPort => ({ chat: vi.fn((req) => Promise.resolve(respond(req))) });

describe("generateXArticleContent", () => {
  it("sends article system prompt and X user sections", async () => {
    const llm = makeLlm((req) => {
      expect(req.messages[0]!.content).toMatch(/X（Twitter）/);
      expect(req.messages[1]!.content).toMatch(/Structured notes/);
      expect(req.temperature).toBeCloseTo(0.55);
      return { content: "# T\n\nbody", model: "m", finishReason: "stop" };
    });
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nbody");
    expect(r.videoId).toBe("vid");
  });

  it("strips markdown fence wrapper", async () => {
    const llm = makeLlm(() => ({
      content: "```markdown\n# T\n\nx\n```",
      model: "m",
      finishReason: "stop",
    }));
    const r = await generateXArticleContent({ llm, model: "m", artifacts: fakeArtifacts });
    expect(r.content).toBe("# T\n\nx");
  });
});
