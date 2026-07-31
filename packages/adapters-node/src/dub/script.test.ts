import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort, Utterance } from "@yt2x/core";
import { generateDubScript } from "./script.js";

// 每句给足 8s 时长：让默认时长模型算出的字符预算（约 53 字）远大于测试用的
// 短译文，避免 translateUtterances 的超预算收紧通道意外发起额外一轮请求。
const utterance = (index: number, text: string): Utterance => ({
  index,
  startMs: (index - 1) * 10_000,
  endMs: (index - 1) * 10_000 + 8_000,
  text,
  wordCount: text.split(" ").length,
});

type Handler = (req: ChatRequest, call: number) => string | Promise<string>;

const stubLlm = (handler: Handler): { llm: LlmPort; requests: ChatRequest[] } => {
  const requests: ChatRequest[] = [];
  const llm: LlmPort = {
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      requests.push(req);
      const content = await handler(req, requests.length);
      return { content, model: req.model, finishReason: "stop" };
    },
  };
  return { llm, requests };
};

const baseInput = (utterances: readonly Utterance[], llm: LlmPort) => ({
  llm,
  model: "test-model",
  videoId: "<videoId>",
  sourceWords: "video/full.local.en.words.json",
  utterances,
});

const jsonLines = (lines: readonly { index: number; text: string }[]): string =>
  JSON.stringify(lines);

describe("generateDubScript", () => {
  it("translates every utterance and keeps the English source for auditing", async () => {
    const utterances = [
      utterance(1, "so we need a new plan"),
      utterance(2, "we also need to think about cost"),
    ];
    const { llm, requests } = stubLlm(() =>
      jsonLines([
        { index: 1, text: "所以我们需要一个新方案" },
        { index: 2, text: "另外还要看成本" },
      ]),
    );

    const result = await generateDubScript(baseInput(utterances, llm));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.jsonMode).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.translatedCount).toBe(2);
    expect(result.droppedCount).toBe(0);
    expect(result.script).toMatchObject({
      version: 2,
      videoId: "<videoId>",
      sourceWords: "video/full.local.en.words.json",
      rewriteModel: "test-model",
      droppedCount: 0,
    });
    expect(result.script.lines[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 8_000,
      targetDurationMs: 8_000,
      text: "所以我们需要一个新方案",
      sourceText: "so we need a new plan",
      cueIndices: [1],
    });
  });

  it("batches long inputs at 20 utterances per request", async () => {
    const utterances = Array.from({ length: 45 }, (_, i) => utterance(i + 1, `sentence ${i + 1}`));
    const { llm, requests } = stubLlm((req) => {
      const payload = JSON.parse(req.messages[1]!.content) as { index: number }[];
      return jsonLines(payload.map((item) => ({ index: item.index, text: `译${item.index}` })));
    });

    const result = await generateDubScript(baseInput(utterances, llm));

    expect(requests).toHaveLength(3);
    expect(result.script.lines).toHaveLength(45);
    expect(result.droppedCount).toBe(0);
    expect(result.script.lines.at(-1)?.text).toBe("译45");
  });

  it("drops an utterance that never gets a translation, without a fabricated fallback", async () => {
    const utterances = [utterance(1, "first sentence"), utterance(2, "second sentence")];
    const { llm } = stubLlm((_req, call) =>
      call === 1 ? jsonLines([{ index: 1, text: "第一句" }]) : "still not json",
    );

    const result = await generateDubScript(baseInput(utterances, llm));

    expect(result.script.lines).toHaveLength(1);
    expect(result.script.lines[0]?.text).toBe("第一句");
    expect(result.droppedCount).toBe(1);
    // 落盘的 script.droppedCount 必须和结果一致：门禁只读 script，不读 result。
    expect(result.script.droppedCount).toBe(1);
    expect(result.translatedCount).toBe(1);
    expect(
      result.warnings.some((w) => w.includes("1/2 utterances have no usable translation")),
    ).toBe(true);
  });

  it("keeps utterance order in the assembled script even when the LLM replies out of order", async () => {
    const utterances = [utterance(1, "first"), utterance(2, "second"), utterance(3, "third")];
    const { llm } = stubLlm(() =>
      jsonLines([
        { index: 3, text: "第三" },
        { index: 1, text: "第一" },
        { index: 2, text: "第二" },
      ]),
    );

    const result = await generateDubScript(baseInput(utterances, llm));
    expect(result.script.lines.map((l) => l.text)).toEqual(["第一", "第二", "第三"]);
  });

  it("computes targetDurationMs from the utterance span", async () => {
    const utterances: Utterance[] = [
      { index: 1, startMs: 1_000, endMs: 3_500, text: "hello there", wordCount: 2 },
    ];
    const { llm } = stubLlm(() => jsonLines([{ index: 1, text: "你好" }]));
    const result = await generateDubScript(baseInput(utterances, llm));
    expect(result.script.lines[0]?.targetDurationMs).toBe(2_500);
  });

  it("handles an empty utterance list without calling the LLM", async () => {
    const { llm, requests } = stubLlm(() => "[]");
    const result = await generateDubScript(baseInput([], llm));
    expect(requests).toHaveLength(0);
    expect(result.script.lines).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });
});
