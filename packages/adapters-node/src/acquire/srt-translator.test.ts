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

    const result = await translateSrt(sampleSrt, {
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

  it("throws when translation returns wrong block count", async () => {
    const llm = mockLlm(
      JSON.stringify([{ index: 1, text: "你好世界" }]),
    );

    await expect(
      translateSrt(sampleSrt, {
        llm,
        model: "test",
        sourceLang: "en",
        targetLang: "zh-CN",
      }),
    ).rejects.toThrow(/expected 3/);
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
    ).rejects.toThrow(/not a JSON array/);
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

    const result = await translateSrt(sampleSrt, {
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

    const result = await translateSrt(sampleSrt, {
      llm,
      model: "test",
      sourceLang: "en",
      targetLang: "zh-CN",
    });

    expect(calls).toBe(2);
    expect(result).toContain("你好世界");
  });
});
