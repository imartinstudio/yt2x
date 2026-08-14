import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, LlmPort, Utterance } from "@yt2x/core";
import { generateDubScript } from "./script.js";

// 每句给足 8s 时长，字符预算约 53 字。测试用的译文长度需要落在 [0.6, 1.0] 倍预算
// 区间内（约 32-53 字），否则会意外触发 translateUtterances 的超预算收紧或
// 低于预算反向重译通道，多发一轮请求。
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
      if ((req.messages.find((m) => m.role === "system")?.content ?? "").includes("严格的源级专业术语发现器")) {
        return { content: "[]", model: req.model, finishReason: "stop" };
      }
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
        { index: 1, text: "所以我们现在真的需要重新制定一个全新的完整方案，必须尽快落地执行到位" },
        { index: 2, text: "另外我们还得认真考虑一下这件事情背后的实际成本问题，千万不要忽略了它" },
      ]),
    );

    const result = await generateDubScript(baseInput(utterances, llm));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.jsonMode).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.translatedCount).toBe(2);
    expect(result.droppedCount).toBe(0);
    expect(result.script).toMatchObject({
      version: 3,
      videoId: "<videoId>",
      sourceWords: "video/full.local.en.words.json",
      rewriteModel: "test-model",
      droppedCount: 0,
    });
    expect(result.script.technicalTermProfileFingerprint).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(result.script.lines[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 8_000,
      targetDurationMs: 8_000,
      text: "所以我们现在真的需要重新制定一个全新的完整方案，必须尽快落地执行到位",
      sourceText: "so we need a new plan",
      cueIndices: [1],
    });
  });

  it("batches long inputs at 20 utterances per request", async () => {
    const utterances = Array.from({ length: 45 }, (_, i) => utterance(i + 1, `sentence ${i + 1}`));
    // 35 字左右的占位译文，落在 [32, 53] 预算区间内，避免触发额外的收紧/扩写请求。
    // 必须带标点：零标点的长句会被判为电报体，触发第四道「口语化重写」请求，
    // 让这条数批次的断言失真。
    const longTranslation = (index: number): string =>
      `这是用于批处理测试的中文配音译文，占位内容示例文字，用于凑够预算长度，第${index}句`;
    const { llm, requests } = stubLlm((req) => {
      const payload = JSON.parse(req.messages[1]!.content) as { index: number }[];
      return jsonLines(
        payload.map((item) => ({ index: item.index, text: longTranslation(item.index) })),
      );
    });

    const result = await generateDubScript(baseInput(utterances, llm));

    expect(requests).toHaveLength(3);
    expect(result.script.lines).toHaveLength(45);
    expect(result.droppedCount).toBe(0);
    expect(result.script.lines.at(-1)?.text).toBe(longTranslation(45));
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
