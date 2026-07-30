import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, DubSegment, LlmPort } from "@yt2x/core";
import { generateDubScript } from "./script.js";

const segment = (index: number, text: string): DubSegment => ({
  index,
  startMs: (index - 1) * 3_000,
  endMs: (index - 1) * 3_000 + 2_500,
  cueIndices: [index * 2 - 1, index * 2],
  text,
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

const baseInput = (segments: readonly DubSegment[], llm: LlmPort) => ({
  llm,
  model: "test-model",
  videoId: "<videoId>",
  sourceSubtitle: "video/full.zh.srt",
  segments,
});

const jsonLines = (lines: readonly { index: number; text: string }[]): string =>
  JSON.stringify(lines);

describe("generateDubScript", () => {
  it("rewrites every segment and keeps the source text for auditing", async () => {
    const segments = [segment(1, "因此我们需要一个新的方案"), segment(2, "此外还要考虑成本")];
    const { llm, requests } = stubLlm(() =>
      jsonLines([
        { index: 1, text: "所以我们需要一个新方案" },
        { index: 2, text: "另外还要看成本" },
      ]),
    );

    const result = await generateDubScript(baseInput(segments, llm));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.jsonMode).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.rewrittenCount).toBe(2);
    expect(result.fallbackCount).toBe(0);
    expect(result.script).toMatchObject({
      version: 1,
      videoId: "<videoId>",
      sourceSubtitle: "video/full.zh.srt",
      rewriteModel: "test-model",
    });
    expect(result.script.lines[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 2_500,
      targetDurationMs: 2_500,
      text: "所以我们需要一个新方案",
      sourceText: "因此我们需要一个新的方案",
      cueIndices: [1, 2],
    });
  });

  it("batches long inputs at 20 segments per request", async () => {
    const segments = Array.from({ length: 45 }, (_, i) => segment(i + 1, `第${i + 1}句`));
    const { llm, requests } = stubLlm((req) => {
      const payload = JSON.parse(req.messages[1]!.content) as { index: number }[];
      return jsonLines(payload.map((item) => ({ index: item.index, text: `改写${item.index}` })));
    });

    const result = await generateDubScript(baseInput(segments, llm));

    expect(requests).toHaveLength(3);
    expect(result.script.lines).toHaveLength(45);
    expect(result.fallbackCount).toBe(0);
    expect(result.script.lines.at(-1)?.text).toBe("改写45");
  });

  it("repairs lines the model skipped", async () => {
    const segments = [segment(1, "第一句"), segment(2, "第二句"), segment(3, "第三句")];
    const { llm, requests } = stubLlm((_req, call) =>
      call === 1
        ? jsonLines([
            { index: 1, text: "改写一" },
            { index: 3, text: "改写三" },
          ])
        : jsonLines([{ index: 2, text: "补回二" }]),
    );

    const result = await generateDubScript(baseInput(segments, llm));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages[0]?.content).toContain("The indices are: 2");
    expect(result.script.lines.map((l) => l.text)).toEqual(["改写一", "补回二", "改写三"]);
    expect(result.fallbackCount).toBe(0);
    expect(result.warnings).toContain("repaired 1/1 missing lines");
  });

  it("falls back to per-line repair before giving up", async () => {
    const segments = [segment(1, "第一句"), segment(2, "第二句")];
    const { llm, requests } = stubLlm((req, call) => {
      if (call === 1) return jsonLines([{ index: 1, text: "改写一" }]);
      if (call === 2) return "not json at all";
      const payload = JSON.parse(req.messages[1]!.content) as { index: number }[];
      return jsonLines(payload.map((item) => ({ index: item.index, text: "单句补回" })));
    });

    const result = await generateDubScript(baseInput(segments, llm));

    expect(requests).toHaveLength(3);
    expect(result.script.lines[1]?.text).toBe("单句补回");
    expect(result.fallbackCount).toBe(0);
  });

  it("falls back to the merged source text instead of failing the whole run", async () => {
    const segments = [segment(1, "第一句"), segment(2, "第二句")];
    const { llm } = stubLlm((_req, call) =>
      call === 1 ? jsonLines([{ index: 1, text: "改写一" }]) : "still not json",
    );

    const result = await generateDubScript(baseInput(segments, llm));

    expect(result.script.lines[1]?.text).toBe("第二句");
    expect(result.script.lines[1]?.sourceText).toBe("第二句");
    expect(result.fallbackCount).toBe(1);
    expect(result.rewrittenCount).toBe(1);
    expect(result.warnings.some((w) => w.includes("fell back to the merged source text"))).toBe(true);
  });

  it("records a warning when a whole batch call throws, then repairs", async () => {
    const segments = [segment(1, "第一句")];
    const { llm } = stubLlm((_req, call) => {
      if (call === 1) throw new Error("upstream 500");
      return jsonLines([{ index: 1, text: "重试成功" }]);
    });

    const result = await generateDubScript(baseInput(segments, llm));

    expect(result.warnings.some((w) => w.includes("upstream 500"))).toBe(true);
    expect(result.script.lines[0]?.text).toBe("重试成功");
    expect(result.fallbackCount).toBe(0);
  });

  it("keeps warnings when even the repair pass throws", async () => {
    const segments = [segment(1, "第一句")];
    const { llm } = stubLlm(() => {
      throw new Error("provider down");
    });

    const result = await generateDubScript(baseInput(segments, llm));

    expect(result.warnings.some((w) => w.includes("repair pass failed"))).toBe(true);
    expect(result.fallbackCount).toBe(1);
    expect(result.script.lines[0]?.text).toBe("第一句");
  });

  it("salvages a truncated JSON array", async () => {
    const segments = [segment(1, "第一句"), segment(2, "第二句")];
    const { llm } = stubLlm((_req, call) =>
      call === 1
        ? '[{"index":1,"text":"改写一"},{"index":2,"text":"改写二'
        : jsonLines([{ index: 2, text: "补回二" }]),
    );

    const result = await generateDubScript(baseInput(segments, llm));
    expect(result.script.lines[0]?.text).toBe("改写一");
    expect(result.script.lines[1]?.text).toBe("补回二");
  });

  it("strips code fences around the JSON array", async () => {
    const segments = [segment(1, "第一句")];
    const { llm } = stubLlm(() => '```json\n[{"index":1,"text":"改写一"}]\n```');
    const result = await generateDubScript(baseInput(segments, llm));
    expect(result.script.lines[0]?.text).toBe("改写一");
  });

  it("ignores indices the model invented", async () => {
    const segments = [segment(1, "第一句")];
    const { llm } = stubLlm((_req, call) =>
      call === 1
        ? jsonLines([
            { index: 99, text: "凭空捏造" },
            { index: 1, text: "改写一" },
          ])
        : "[]",
    );

    const result = await generateDubScript(baseInput(segments, llm));
    expect(result.script.lines).toHaveLength(1);
    expect(result.script.lines[0]?.text).toBe("改写一");
  });

  it("treats an empty rewritten string as missing", async () => {
    const segments = [segment(1, "第一句")];
    const { llm } = stubLlm((_req, call) =>
      call === 1 ? jsonLines([{ index: 1, text: "   " }]) : jsonLines([{ index: 1, text: "补回一" }]),
    );

    const result = await generateDubScript(baseInput(segments, llm));
    expect(result.script.lines[0]?.text).toBe("补回一");
  });

  it("computes targetDurationMs from the segment span and never goes negative", async () => {
    const segments: DubSegment[] = [
      { index: 1, startMs: 5_000, endMs: 4_000, cueIndices: [1], text: "时间戳反了" },
    ];
    const { llm } = stubLlm(() => jsonLines([{ index: 1, text: "时间戳反了" }]));
    const result = await generateDubScript(baseInput(segments, llm));
    expect(result.script.lines[0]?.targetDurationMs).toBe(0);
  });

  it("handles an empty segment list without calling the LLM", async () => {
    const { llm, requests } = stubLlm(() => "[]");
    const result = await generateDubScript(baseInput([], llm));
    expect(requests).toHaveLength(0);
    expect(result.script.lines).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
