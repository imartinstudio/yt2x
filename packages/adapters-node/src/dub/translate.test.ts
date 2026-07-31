import { describe, expect, it } from "vitest";
import type { LlmPort, Utterance } from "@yt2x/core";
import { translateUtterances } from "./translate.js";

const utt = (index: number, ms: number, text: string): Utterance => ({
  index,
  startMs: (index - 1) * ms,
  endMs: index * ms,
  text,
  wordCount: text.split(" ").length,
});

/** 按给定的「index → 译文」表作答；记录每次收到的 payload 供断言。 */
const stubLlm = (
  answer: (indices: number[]) => Record<number, string>,
): { llm: LlmPort; payloads: { index: number; maxChars: number }[][]; calls: () => number } => {
  const payloads: { index: number; maxChars: number }[][] = [];
  let calls = 0;
  const llm: LlmPort = {
    chat: async (req) => {
      calls += 1;
      const user = req.messages.find((m) => m.role === "user")?.content ?? "[]";
      const items = JSON.parse(user) as { index: number; maxChars: number }[];
      payloads.push(items);
      const table = answer(items.map((i) => i.index));
      const out = Object.entries(table).map(([index, text]) => ({ index: Number(index), text }));
      return { content: JSON.stringify(out), model: req.model, finishReason: "stop" as const };
    },
  };
  return { llm, payloads, calls: () => calls };
};

const allOf = (indices: number[]): Record<number, string> =>
  Object.fromEntries(indices.map((i) => [i, `译文${i}`]));

describe("translateUtterances", () => {
  it("returns one line per utterance, keyed by the original index", async () => {
    const { llm } = stubLlm((idx) => allOf(idx));
    const { lines, warnings } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "hello"), utt(2, 3_000, "world")],
    });
    expect(lines.map((l) => l.index)).toEqual([1, 2]);
    expect(lines.map((l) => l.text)).toEqual(["译文1", "译文2"]);
    expect(warnings).toEqual([]);
  });

  it("sends each utterance's own character budget to the model", async () => {
    const stub = stubLlm((idx) => allOf(idx));
    await translateUtterances({
      llm: stub.llm,
      model: "m",
      utterances: [utt(1, 2_000, "short"), utt(2, 9_000, "a far longer stretch")],
    });
    const sent = stub.payloads[0]!;
    expect(sent[0]!.maxChars).toBeGreaterThan(0);
    expect(sent[1]!.maxChars).toBeGreaterThan(sent[0]!.maxChars);
  });

  it("carries the source text so the result can be audited against it", async () => {
    const { llm } = stubLlm((idx) => allOf(idx));
    const { lines } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "the source sentence")],
    });
    expect(lines[0]?.sourceText).toBe("the source sentence");
  });

  it("repairs lines the model omitted instead of silently dropping them", async () => {
    let pass = 0;
    const { llm } = stubLlm((idx) => {
      pass += 1;
      // 首轮故意漏掉 index 2，补齐轮才给
      return pass === 1 ? allOf(idx.filter((i) => i !== 2)) : allOf(idx);
    });
    const { lines, warnings } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "a"), utt(2, 3_000, "b")],
    });
    expect(lines.map((l) => l.index)).toEqual([1, 2]);
    expect(warnings.join(" ")).toMatch(/repair/i);
  });

  it("reports a line it could never obtain rather than inventing one", async () => {
    const { llm } = stubLlm((idx) => allOf(idx.filter((i) => i !== 2)));
    const { lines, warnings } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "a"), utt(2, 3_000, "b")],
    });
    expect(lines.map((l) => l.index)).toEqual([1]);
    expect(warnings.join(" ")).toMatch(/2/);
  });

  it("ignores indices the model invented", async () => {
    const { llm } = stubLlm(() => ({ 1: "译文1", 99: "凭空捏造" }));
    const { lines } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "a")],
    });
    expect(lines.map((l) => l.index)).toEqual([1]);
  });

  it("survives a batch that throws, and still repairs it", async () => {
    let call = 0;
    const llm: LlmPort = {
      chat: async (req) => {
        call += 1;
        if (call === 1) throw new Error("upstream exploded");
        const user = req.messages.find((m) => m.role === "user")?.content ?? "[]";
        const items = JSON.parse(user) as { index: number }[];
        return {
          content: JSON.stringify(items.map((i) => ({ index: i.index, text: `译文${i.index}` }))),
          model: req.model,
          finishReason: "stop" as const,
        };
      },
    };
    const { lines, warnings } = await translateUtterances({
      llm,
      model: "m",
      utterances: [utt(1, 3_000, "a")],
    });
    expect(lines.map((l) => l.index)).toEqual([1]);
    expect(warnings.join(" ")).toMatch(/exploded/);
  });

  it("returns nothing for an empty utterance list without calling the model", async () => {
    const stub = stubLlm((idx) => allOf(idx));
    const { lines } = await translateUtterances({ llm: stub.llm, model: "m", utterances: [] });
    expect(lines).toEqual([]);
    expect(stub.calls()).toBe(0);
  });
});
