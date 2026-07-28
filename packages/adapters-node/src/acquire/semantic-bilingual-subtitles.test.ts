import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort } from "@yt2x/core";
import { parseSubtitleBlocks } from "./video-subtitles.js";
import {
  type SemanticProjectionError,
  projectSemanticBilingualSubtitles,
  type SubtitleLayoutMeasurement,
} from "./semantic-bilingual-subtitles.js";

const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half

3
00:00:03,200 --> 00:00:04,500
Another

4
00:00:04,500 --> 00:00:06,000
complete thought
`;

const makeLlm = (content: string): LlmPort => ({
  chat: vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
    content,
    model: "test-model",
    finishReason: "stop",
  })),
});

const fitMeasurement = async (srt: string): Promise<SubtitleLayoutMeasurement[]> =>
  parseSubtitleBlocks(srt).map((cue) => ({
    cueIndex: cue.index,
    zhWidth: 200,
    fitWidth: 1024,
    lineCount: 1,
    severity: "fit",
    resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
  }));

describe("projectSemanticBilingualSubtitles", () => {
  it("projects contiguous source cues into natural bilingual sentence groups", async () => {
    const llm = makeLlm(
      JSON.stringify({
        groups: [
          { sourceStartIndex: 1, sourceEndIndex: 2, zhText: "自然中文句" },
          { sourceStartIndex: 3, sourceEndIndex: 4, zhText: "另一个完整观点" },
        ],
      }),
    );

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    expect(parseSubtitleBlocks(result.bilingualSrt)).toEqual([
      expect.objectContaining({
        start: "00:00:00,000",
        end: "00:00:03,000",
        text: ["自然中文句", "First half second half"],
      }),
      expect.objectContaining({
        start: "00:00:03,200",
        end: "00:00:06,000",
        text: ["另一个完整观点", "Another complete thought"],
      }),
    ]);
    expect(parseSubtitleBlocks(result.enSrt)).toHaveLength(2);
    expect(parseSubtitleBlocks(result.zhSrt)).toHaveLength(2);
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.groups[0]!.groupId).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.quality).toEqual({ readyForBurn: true, issues: [] });
  });

  it.each([
    {
      name: "non-json",
      response: "not json",
      code: "invalid-json",
    },
    {
      name: "gap",
      response: JSON.stringify({
        groups: [{ sourceStartIndex: 2, sourceEndIndex: 4, zhText: "遗漏第一条" }],
      }),
      code: "invalid-contiguous-coverage",
    },
    {
      name: "overlap",
      response: JSON.stringify({
        groups: [
          { sourceStartIndex: 1, sourceEndIndex: 2, zhText: "第一组" },
          { sourceStartIndex: 2, sourceEndIndex: 4, zhText: "重复第二条" },
        ],
      }),
      code: "invalid-contiguous-coverage",
    },
    {
      name: "empty text",
      response: JSON.stringify({
        groups: [{ sourceStartIndex: 1, sourceEndIndex: 4, zhText: " " }],
      }),
      code: "invalid-contiguous-coverage",
    },
  ])("rejects $name responses with a machine-readable code", async ({ response, code }) => {
    await expect(
      projectSemanticBilingualSubtitles({
        sourceSrt,
        llm: makeLlm(response),
        model: "test-model",
        measureLayout: fitMeasurement,
      }),
    ).rejects.toMatchObject<Partial<SemanticProjectionError>>({ code });
  });

  it("derives stable group ids from trusted source ranges", async () => {
    const response = JSON.stringify({
      groups: [{ sourceStartIndex: 1, sourceEndIndex: 4, zhText: "完整中文句" }],
    });
    const options = {
      sourceSrt,
      model: "test-model",
      measureLayout: fitMeasurement,
    };

    const first = await projectSemanticBilingualSubtitles({ ...options, llm: makeLlm(response) });
    const second = await projectSemanticBilingualSubtitles({ ...options, llm: makeLlm(response) });

    expect(first.groups[0]!.groupId).toBe(second.groups[0]!.groupId);
    expect(first.groups[0]!.sourceText).toBe(
      "First half second half Another complete thought",
    );
  });
});
