import { describe, expect, it } from "vitest";
import type { LlmPort, ChatResponse, ChatRequest } from "@yt2x/core";
import { translateSrt } from "./srt-translator.js";

const mockLlm = (response: string): LlmPort => ({
  chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
    content: response,
    model: "test-model",
    finishReason: "stop",
    usage: { promptTokens: 10, completionTokens: 5 },
  }),
});

const sampleSrt = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:04,000 --> 00:00:06,000
How are you today

3
00:00:07,000 --> 00:00:09,500
Goodbye now
`;

describe("translateSrt", () => {
  it("translates SRT blocks and preserves timecodes", async () => {
    const llm = mockLlm(
      JSON.stringify([
        { index: 1, text: "你好世界" },
        { index: 2, text: "你今天好吗" },
        { index: 3, text: "现在再见" },
      ]),
    );

    const { srt: result } = await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(result).toContain("00:00:01,000 --> 00:00:03,500");
    expect(result).toContain("你好世界");
    expect(result).toContain("00:00:04,000 --> 00:00:06,000");
    expect(result).toContain("你今天好吗");
    expect(result).toContain("00:00:07,000 --> 00:00:09,500");
    expect(result).toContain("现在再见");
  });

  it("completes with fallback when translation returns too few blocks", async () => {
    // Phase 5 fallback: small mismatches (<3% or ≤2 cues) are filled with
    // English source text + "[未翻译]" prefix instead of throwing.
    const llm = mockLlm(
      JSON.stringify([{ index: 1, text: "你好世界" }]),
    );

    const result = await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    // Should complete successfully with fallback warnings
    expect(result.warnings.some((w) => w.includes("could not be translated"))).toBe(true);
    // Output SRT should contain all 3 cues
    const blocks = result.srt.trim().split("\n\n");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
  });

  it("throws when translation returns zero blocks", async () => {
    // A complete failure (0 blocks) should still throw after all repair phases
    const llm = mockLlm("[]");

    await expect(
      translateSrt(sampleSrt, {
        llm,
        model: "test",
        sourceLang: "en",
        targetLang: "zh-CN",
      }),
    ).rejects.toThrow(/after 5 repair phases/);
  });

  it("throws when response is not a JSON array", async () => {
    const llm = mockLlm('{"blocks": []}');

    await expect(
      translateSrt(sampleSrt, {
        llm,
        model: "test",
        sourceLang: "en",
        targetLang: "zh-CN",
      }),
    ).rejects.toThrow(/translation returned 0/);
  });

  it("throws on empty SRT input", async () => {
    const llm = mockLlm("[]");
    await expect(
      translateSrt("", { llm, model: "test", sourceLang: "en", targetLang: "zh-CN" }),
    ).rejects.toThrow(/no subtitle blocks/);
  });

  it("repairs missing blocks via a second pass", async () => {
    let callCount = 0;
    const llm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        callCount++;
        // First call (batch): returns only 2 of 3 blocks
        if (callCount === 1) {
          return {
            content: JSON.stringify([
              { index: 1, text: "你好世界" },
              { index: 3, text: "现在再见" },
            ]),
            model: "test",
            finishReason: "stop",
          };
        }
        // Second call (repair for missing index 2)
        const parsed = JSON.parse(req.messages[1]!.content) as Array<{ index: number }>;
        const missingIndex = parsed[0]!.index;
        return {
          content: JSON.stringify([{ index: missingIndex, text: `修复${missingIndex}` }]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const { srt: result } = await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(result).toContain("你好世界");
    expect(result).toContain("修复2");
    expect(result).toContain("现在再见");
    expect(result).toContain("00:00:04,000 --> 00:00:06,000");
  });

  it("retries once on LLM failure", async () => {
    let calls = 0;
    const llm: LlmPort = {
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        calls++;
        if (calls === 1) {
          throw new Error("network error");
        }
        return {
          content: JSON.stringify([
            { index: 1, text: "你好世界" },
            { index: 2, text: "你今天好吗" },
            { index: 3, text: "现在再见" },
          ]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const { srt: result } = await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(calls).toBe(2);
    expect(result).toContain("你好世界");
  });

  it("survives a truncated JSON array by salvaging complete objects", async () => {
    // Simulates the actual bug: LLM returns truncated JSON array.
    // salvagePartialJsonArray recovers 1 complete object from the truncation.
    // Phase 2 repair fills the remaining 2 missing blocks.
    const trunc = `[
      {"index":1,"text":"你好世界"},
      {"index":2,"text":"你今天`; // truncated mid-object

    let callCount = 0;
    const repairingLlm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        callCount++;
        if (callCount === 1) {
          // Phase 1 batch: truncated response — only 1 complete object salvageable
          return { content: trunc, model: "test", finishReason: "stop" };
        }
        // Phase 2/3 repair: return blocks for whatever indices were requested
        const requested = JSON.parse(req.messages[1]!.content) as Array<{ index: number }>;
        return {
          content: JSON.stringify(
            requested.map((b) => ({ index: b.index, text: `修复${b.index}` })),
          ),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const { srt: result, warnings } = await translateSrt(sampleSrt, {
      llm: repairingLlm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(result).toContain("你好世界");
    expect(result).toContain("修复2");
    expect(result).toContain("修复3");
    // Should have warned about the partial batch
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("warns on partial batch results instead of throwing", async () => {
    // Second batch returns only 1 block → repair fills the gap
    const longSrt = `1
00:00:01,000 --> 00:00:03,500
Block one

2
00:00:04,000 --> 00:00:06,000
Block two

3
00:00:07,000 --> 00:00:09,500
Block three

4
00:00:10,000 --> 00:00:12,500
Block four
`;

    // BATCH_SIZE is 30, so all 4 blocks go in one batch.
    // First call returns partial, second (repair) fills missing.
    let callCount = 0;
    const llm: LlmPort = {
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        callCount++;
        if (callCount === 1) {
          return {
            content: JSON.stringify([
              { index: 1, text: "区块1" },
              { index: 4, text: "区块4" },
            ]),
            model: "test",
            finishReason: "stop",
          };
        }
        return {
          content: JSON.stringify([
            { index: 2, text: "修复2" },
            { index: 3, text: "修复3" },
          ]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    const { srt: result } = await translateSrt(longSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(result).toContain("区块1");
    expect(result).toContain("修复2");
    expect(result).toContain("修复3");
    expect(result).toContain("区块4");
    expect(callCount).toBe(2);
  });

  it("instructs zh-CN translations to convert Traditional Chinese to Simplified Chinese", async () => {
    let systemPrompt = "";
    const llm: LlmPort = {
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        systemPrompt = req.messages[0]!.content;
        return {
          content: JSON.stringify([
            { index: 1, text: "你好世界" },
            { index: 2, text: "你今天好吗" },
            { index: 3, text: "现在再见" },
          ]),
          model: "test",
          finishReason: "stop",
        };
      },
    };

    await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "zh-Hant",
      targetLang: "zh-CN",
    });

    expect(systemPrompt).toMatch(/Simplified Chinese/);
    expect(systemPrompt).toMatch(/Traditional Chinese output is FORBIDDEN/);
  });
});
