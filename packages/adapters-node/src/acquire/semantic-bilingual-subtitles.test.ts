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

  it("re-aligns only hard groups and preserves groups that already fit", async () => {
    const firstPass = JSON.stringify({
      groups: [
        { sourceStartIndex: 1, sourceEndIndex: 2, zhText: "第一句过长的中文翻译" },
        { sourceStartIndex: 3, sourceEndIndex: 4, zhText: "保持不变" },
      ],
    });
    const responses = [
      firstPass,
      JSON.stringify({
        replacements: [
          {
            parentGroupId:
              "ignored-by-test",
            groups: [
              { sourceStartIndex: 1, sourceEndIndex: 1, zhText: "第一句" },
              { sourceStartIndex: 2, sourceEndIndex: 2, zhText: "第二句" },
            ],
          },
        ],
      }),
    ];
    let measurementRound = 0;
    const llm: LlmPort = {
      chat: vi.fn(async (request) => {
        const index = vi.mocked(llm.chat).mock.calls.length - 1;
        if (index === 1) {
          const user = JSON.parse(request.messages[1]!.content) as {
            hardGroups: Array<{ groupId: string }>;
          };
          const parsed = JSON.parse(responses[1]!) as {
            replacements: Array<{ parentGroupId: string }>;
          };
          parsed.replacements[0]!.parentGroupId = user.hardGroups[0]!.groupId;
          return { content: JSON.stringify(parsed), model: "test-model", finishReason: "stop" };
        }
        return { content: responses[0]!, model: "test-model", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt: sourceSrt.replace("First half", "First sentence."),
      llm,
      model: "test-model",
      measureLayout: async (srt) => {
        measurementRound += 1;
        return parseSubtitleBlocks(srt).map((cue) => ({
          cueIndex: cue.index,
          zhWidth: cue.index === 1 && measurementRound === 1 ? 1400 : 200,
          fitWidth: 1024,
          lineCount: cue.index === 1 && measurementRound === 1 ? 3 : 1,
          severity: cue.index === 1 && measurementRound === 1 ? "hard" : "fit",
          resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
        }));
      },
    });

    expect(llm.chat).toHaveBeenCalledTimes(2);
    const secondRequest = vi.mocked(llm.chat).mock.calls[1]![0];
    expect(secondRequest.messages[1]!.content).toContain('"hardGroups"');
    expect(secondRequest.messages[1]!.content).not.toContain('"sourceStartIndex":3');
    expect(result.groups.map((group) => [group.sourceStartIndex, group.sourceEndIndex])).toEqual([
      [1, 1],
      [2, 2],
      [3, 4],
    ]);
    expect(result.groups[2]!.zhText).toBe("保持不变");
    expect(result.quality.readyForBurn).toBe(true);
  });

  it("keeps an unsplittable hard group as a presentation blocker", async () => {
    const llm = makeLlm(JSON.stringify({
      groups: [{ sourceStartIndex: 1, sourceEndIndex: 1, zhText: "非常长的中文翻译" }],
    }));
    const result = await projectSemanticBilingualSubtitles({
      sourceSrt: `1\n00:00:00,000 --> 00:00:02,000\nOne cue\n`,
      llm,
      model: "test-model",
      measureLayout: async () => [{
        cueIndex: 1,
        zhWidth: 1600,
        fitWidth: 1024,
        lineCount: 3,
        severity: "hard",
        resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
      }],
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.quality.readyForBurn).toBe(false);
    expect(result.quality.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hard-layout", severity: "presentation" }),
    ]));
  });
});
