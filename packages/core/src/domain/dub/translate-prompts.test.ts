import { describe, expect, it } from "vitest";
import {
  buildDubTranslateExpandPrompt,
  buildDubTranslatePayload,
  buildDubTranslateRepairPrompt,
  buildDubTranslateTightenPrompt,
  buildDubTranslateUserPrompt,
  DEFAULT_SPEECH_RATE,
  dubTranslateCharBudget,
  estimateSpokenMs,
  getDubTranslateSystemPrompt,
  TTS_FIXED_OVERHEAD_MS,
  TTS_MS_PER_CHINESE_CHAR,
} from "./translate-prompts.js";
import type { Utterance } from "./types.js";

const utt = (index: number, startMs: number, endMs: number, text: string): Utterance => ({
  index,
  startMs,
  endMs,
  text,
  wordCount: text.split(" ").length,
});

describe("dubTranslateCharBudget", () => {
  it("charges the fixed overhead before allotting any characters", () => {
    const rate = { fixedOverheadMs: 2_000, msPerChar: 100 };
    // 2000ms 全被固定开销吃掉，只剩 1000ms 够 10 个字
    expect(dubTranslateCharBudget(3_000, rate)).toBe(10);
  });

  it("gives a slower voice fewer characters for the same slot", () => {
    const slow = dubTranslateCharBudget(6_000, { fixedOverheadMs: 1_000, msPerChar: 300 });
    const fast = dubTranslateCharBudget(6_000, { fixedOverheadMs: 1_000, msPerChar: 150 });
    expect(fast).toBeGreaterThan(slow);
  });

  it("still allots a character when the slot cannot even cover the overhead", () => {
    // 这类单元靠翻译压不进去，但产出空译文只会变成一段静音
    expect(dubTranslateCharBudget(500, { fixedOverheadMs: 2_000, msPerChar: 100 })).toBe(1);
  });

  it("round-trips against the duration estimate", () => {
    const budget = dubTranslateCharBudget(8_000);
    expect(estimateSpokenMs(budget)).toBeLessThanOrEqual(8_000);
    expect(estimateSpokenMs(budget + 1)).toBeGreaterThan(8_000);
  });

  it("never returns a budget below one character", () => {
    expect(dubTranslateCharBudget(0)).toBeGreaterThanOrEqual(1);
    expect(dubTranslateCharBudget(-500)).toBeGreaterThanOrEqual(1);
  });
});

describe("TTS_FIXED_OVERHEAD_MS / TTS_MS_PER_CHINESE_CHAR", () => {
  it("matches the zh-CN-YunjianNeural calibration, not the stale zh-CN-YunxiNeural values", () => {
    // 回归哨兵：这两个常数曾经按旧音色（云希）标定却从未随默认音色改成云健而重新
    // 校准，导致字符预算系统性偏松、全片被硬门禁拦下。防止未来又出现同样的漂移——
    // 换音色时这个测试会因为常数不匹配而失败，逼开发者显式更新并写清楚标定依据。
    expect(TTS_FIXED_OVERHEAD_MS).toBe(1_132);
    expect(TTS_MS_PER_CHINESE_CHAR).toBe(175.2);
    expect(DEFAULT_SPEECH_RATE).toEqual({
      fixedOverheadMs: 1_132,
      msPerChar: 175.2,
    });
  });
});

describe("getDubTranslateSystemPrompt", () => {
  const prompt = getDubTranslateSystemPrompt();

  it("frames the task as translating to fit, not translating then cutting", () => {
    expect(prompt).toMatch(/fit/i);
    expect(prompt).toMatch(/maxChars/);
  });

  it("tells the model to fill the budget (85-100%), not just avoid exceeding it", () => {
    expect(prompt).toMatch(/FILL the budget/i);
    expect(prompt).toMatch(/85-100%/);
  });

  it("warns that landing far under budget leaves dead air with no voice or subtitle", () => {
    expect(prompt).toMatch(/60%/);
    expect(prompt).toMatch(/no dubbed audio and no subtitle/i);
  });

  it("directs freed-up budget toward completeness, not padding", () => {
    expect(prompt).toMatch(/restore details/i);
    expect(prompt).toMatch(/not merely to consume characters|not padding/i);
  });

  it("requires proper nouns and identifiers to survive verbatim", () => {
    expect(prompt).toMatch(/Proper nouns/i);
    expect(prompt).toMatch(/verbatim|EXACTLY/i);
  });

  it("lists the glossary skill names and names that must never be translated", () => {
    // grill me / grill with docs 是本仓库真实存在的技能名，之前被当成普通短语翻译掉了
    expect(prompt).toMatch(/Grill Me/);
    expect(prompt).toMatch(/Grill with Docs/);
    expect(prompt).toMatch(/Ryan Singer/);
  });

  it("tells the model the glossary match is case-insensitive against the lower-cased transcript", () => {
    // ASR 转写稿几乎总是纯小写，术语表本身是首字母大写拼写
    expect(prompt).toMatch(/case-insensitiv/i);
  });

  it("locks the grill-family derived forms to one consistent Chinese rendering each", () => {
    // 真实成片曾把同一个 grill 译成"提问环节""评审会""可评审""带文档的评审"四种
    // 不同的东西；提示词必须把每个派生形式的译法写死，不能留给模型逐句现场决定
    expect(prompt).toMatch(/grilling session.*追问环节/);
    expect(prompt).toMatch(/grillable.*可追问/);
    expect(prompt).toMatch(/ungrillable.*不可追问/);
    expect(prompt).not.toMatch(/评审/);
  });

  it("locks fidelity to one rendering instead of letting it drift across 保真/精确/精度", () => {
    expect(prompt).toMatch(/fidelity.*保真度/);
  });

  it("tells the model rule 9's skill names win over rule 10's generic grill/fidelity mapping", () => {
    // 真实运行中 LLM 把 "grill me"/"grill with docs" 当成了裸词 "grill" 的派生用法，
    // 套用了追问译法，把技能名也翻译掉了。两条规则必须明确谁优先。
    expect(prompt).toMatch(/does NOT apply to.*grill me.*grill with docs/is);
  });

  it("gives a worked example translating the actual skill-name sentence", () => {
    // 用真实的第一句台词做少样本示例，直接锚定"grill me"/"grill with docs" 保留英文、
    // 其余部分翻译——比抽象规则更能防止模型把整个短语当成普通动词短语处理
    expect(prompt).toMatch(/grill me skills and grill with docs/i);
    expect(prompt).toMatch(/Example/i);
  });

  it("tells the model to spend the budget on redundancy, not on content", () => {
    expect(prompt).toMatch(/filler|redundan/i);
    expect(prompt).toMatch(/fact|number|name/i);
  });

  it("forbids truncation markers, which are the signature of post-hoc cutting", () => {
    expect(prompt).toMatch(/等等|ellips|truncat/i);
  });

  it("demands Simplified Chinese and a JSON array reply", () => {
    expect(prompt).toMatch(/Simplified Chinese/);
    expect(prompt).toMatch(/JSON array/);
  });
});

describe("buildDubTranslatePayload", () => {
  it("carries the character budget derived from each utterance's own duration", () => {
    const payload = buildDubTranslatePayload([
      utt(1, 0, 3_000, "hello there"),
      utt(2, 3_000, 9_000, "a much longer stretch of speech"),
    ]);
    expect(payload[0]).toMatchObject({ index: 1, text: "hello there" });
    expect(payload[1]!.maxChars).toBeGreaterThan(payload[0]!.maxChars);
  });

  it("uses the utterance duration, not its word count", () => {
    const short = buildDubTranslatePayload([utt(1, 0, 1_000, "one two three four five six")]);
    const long = buildDubTranslatePayload([utt(1, 0, 8_000, "one two")]);
    expect(long[0]!.maxChars).toBeGreaterThan(short[0]!.maxChars);
  });
});

describe("buildDubTranslateUserPrompt", () => {
  it("serialises the payload as JSON", () => {
    const prompt = buildDubTranslateUserPrompt([utt(1, 0, 3_000, "hello")]);
    const parsed: unknown = JSON.parse(prompt);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as { index: number }[])[0]?.index).toBe(1);
  });
});

describe("buildDubTranslateRepairPrompt", () => {
  it("pins the missing indices into the instruction", () => {
    const prompt = buildDubTranslateRepairPrompt([3, 7]);
    expect(prompt).toContain("3");
    expect(prompt).toContain("7");
    expect(prompt).toMatch(/EXACTLY|exactly/);
  });
});

describe("buildDubTranslateTightenPrompt", () => {
  const prompt = buildDubTranslateTightenPrompt([{ index: 4, actualChars: 90, maxChars: 76 }]);

  it("pins the previous length and the budget into the instruction", () => {
    expect(prompt).toContain("index 4");
    expect(prompt).toContain("90");
    expect(prompt).toContain("76");
  });

  it("asks for a tighter retranslation, not a cut of the previous attempt", () => {
    expect(prompt).toMatch(/tighter/i);
    expect(prompt).toMatch(/NOT an instruction to cut/i);
  });
});

describe("buildDubTranslateExpandPrompt", () => {
  const prompt = buildDubTranslateExpandPrompt([{ index: 4, actualChars: 27, maxChars: 76 }]);

  it("pins the previous length and the budget into the instruction", () => {
    expect(prompt).toContain("index 4");
    expect(prompt).toContain("27");
    expect(prompt).toContain("76");
  });

  it("explains the consequence: dead air with no voice and no subtitle", () => {
    expect(prompt).toMatch(/dead air/i);
    expect(prompt).toMatch(/no voice and no subtitle/i);
  });

  it("asks for a fuller retranslation, not padding of the previous attempt", () => {
    expect(prompt).toMatch(/use most of the budget/i);
    expect(prompt).toMatch(/NOT an instruction to pad/i);
  });
});
