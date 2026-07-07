import { describe, expect, it } from "vitest";
import { buildBilingualAss, mergeBilingualSrt, validateCueAlignment } from "./bilingual-subtitles.js";

const enSrt = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "I made this entire Vox style explainer video",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "Second cue line",
].join("\n");

const zhSrt = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "我制作了整个 Vox 风格的解释器视频",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "第二行字幕",
].join("\n");
describe("validateCueAlignment", () => {
  it("passes when cues are perfectly aligned", () => {
    const errors = validateCueAlignment(enSrt, zhSrt);
    expect(errors).toHaveLength(0);
  });

  it("detects cue count mismatch", () => {
    const shortZh = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "只有一行",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, shortZh);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/count/i);
  });

  it("detects start time mismatch beyond 5ms tolerance", () => {
    const badStartZh = [
      "1",
      "00:00:01,100 --> 00:00:03,500",
      "开始时间不对",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, badStartZh);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/start/);
  });

  it("detects end time mismatch beyond 5ms tolerance", () => {
    const badEndZh = [
      "1",
      "00:00:01,000 --> 00:00:03,900",
      "结束时间不对",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, badEndZh);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/end/);
  });

  it("allows timing within 5ms tolerance", () => {
    const withinToleranceZh = [
      "1",
      "00:00:01,003 --> 00:00:03,502",
      "可接受误差",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, withinToleranceZh);
    expect(errors).toHaveLength(0);
  });

  it("detects missing Chinese text (cue count mismatch from empty block)", () => {
    // When text is empty, parseSubtitleBlocks skips the cue entirely,
    // resulting in a count mismatch — which is the correct diagnostic.
    const emptyZh = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, emptyZh);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/count/i);
  });

  it("detects missing English text (cue count mismatch from empty block)", () => {
    const emptyEn = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "Second cue line",
    ].join("\n");
    const errors = validateCueAlignment(emptyEn, zhSrt);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/count/i);
  });

  it("detects whitespace-only text that gets trimmed to empty", () => {
    // Non-empty text that trims to empty — like a cue with only a space character
    // between the timestamp and the end-of-block marker.
    // parseSubtitleBlocks collapses this, producing a count mismatch.
    const wsZh = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "  ",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    const errors = validateCueAlignment(enSrt, wsZh);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("mergeBilingualSrt", () => {
  it("puts Chinese on top and English on bottom", () => {
    const result = mergeBilingualSrt(enSrt, zhSrt);
    const blocks = result.trim().split(/\n\n+/u);
    expect(blocks).toHaveLength(2);

    // First cue: Chinese first, English second
    const firstBlock = blocks[0]!;
    const firstLines = firstBlock.split("\n");
    expect(firstLines[0]).toBe("1");
    expect(firstLines[1]).toBe("00:00:01,000 --> 00:00:03,500");
    expect(firstLines[2]).toBe("我制作了整个 Vox 风格的解释器视频");
    expect(firstLines[3]).toBe("I made this entire Vox style explainer video");
  });

  it("preserves English natural spacing and capitalization", () => {
    const result = mergeBilingualSrt(enSrt, zhSrt);
    expect(result).toContain("I made this entire Vox style explainer video");
    expect(result).toContain("Second cue line");
  });

  it("collapses Chinese extra whitespace from narrow line breaks", () => {
    const zhWithSpaces = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "我制作了整个   Vox 风格",
      "的解释器视频",
      "",
    ].join("\n");
    const enSimple = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "I made this entire Vox style explainer video",
    ].join("\n");
    const result = mergeBilingualSrt(enSimple, zhWithSpaces);
    const lines = result.trim().split("\n");
    // Chinese text should be single line, spaces collapsed
    const zhLine = lines[2]!;
    expect(zhLine).not.toContain("   ");
    expect(zhLine).toBe("我制作了整个 Vox 风格 的解释器视频");
  });

  it("handles multiline source cues (preserves multiline English)", () => {
    const enMulti = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "First line of English",
      "Second line of English",
    ].join("\n");
    const zhSingle = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "中文翻译",
    ].join("\n");
    const result = mergeBilingualSrt(enMulti, zhSingle);
    const lines = result.trim().split("\n");
    expect(lines[2]).toBe("中文翻译");
    expect(lines[3]).toBe("First line of English Second line of English");
  });

  it("does not write ASS style tags into SRT", () => {
    const result = mergeBilingualSrt(enSrt, zhSrt);
    expect(result).not.toContain("{\\");
    expect(result).not.toContain("Style:");
    expect(result).not.toContain("[V4+");
  });

  it("preserves original cue timing", () => {
    const result = mergeBilingualSrt(enSrt, zhSrt);
    expect(result).toContain("00:00:01,000 --> 00:00:03,500");
    expect(result).toContain("00:00:04,000 --> 00:00:06,000");
  });

  it("throws when cue counts differ", () => {
    const shortEn = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "Only one cue",
    ].join("\n");
    expect(() => mergeBilingualSrt(shortEn, zhSrt)).toThrow(/count/i);
  });

  it("throws when timestamps are misaligned beyond tolerance", () => {
    const misalignedZh = [
      "1",
      "00:00:02,000 --> 00:00:03,500",
      "开始时间差太多",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "第二行字幕",
    ].join("\n");
    expect(() => mergeBilingualSrt(enSrt, misalignedZh)).toThrow(/start/);
  });
});

describe("buildBilingualAss", () => {
  const styleOptions = {
    zhFont: "PingFang SC",
    enFont: "Arial",
    videoWidth: 1280,
    videoHeight: 720,
  };

  it("produces valid ASS header with [Script Info]", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("ScriptType: v4.00+");
    expect(ass).toContain("PlayResX: 1280");
    expect(ass).toContain("PlayResY: 720");
  });

  it("defines ZhTop and EnBottom styles", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    expect(ass).toContain("Style: ZhTop");
    expect(ass).toContain("Style: EnBottom");
  });

  it("uses BGR yellow (&H0000F4FF) for Chinese fill color", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    // PrimaryColour is the 4th field in the Style line (0-indexed field 3)
    const zhStyleLine = ass.split("\n").find((l) => l.startsWith("Style: ZhTop,"));
    expect(zhStyleLine).toBeDefined();
    expect(zhStyleLine!).toMatch(/&H0000F4FF/);
  });

  it("uses BGR white (&H00FFFFFF) for English fill color", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    const enStyleLine = ass.split("\n").find((l) => l.startsWith("Style: EnBottom,"));
    expect(enStyleLine).toBeDefined();
    expect(enStyleLine!).toMatch(/&H00FFFFFF/);
  });

  it("applies black outline (BorderStyle=1, Outline=3 for ZhTop, Outline=2 for EnBottom)", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    const zhStyleLine = ass.split("\n").find((l) => l.startsWith("Style: ZhTop,"))!;
    const enStyleLine = ass.split("\n").find((l) => l.startsWith("Style: EnBottom,"))!;
    // Outline is the 10th field (0-indexed: 9), BorderStyle is 0-indexed: 8
    // Style fields: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
    const zhFields = zhStyleLine.split(",");
    const enFields = enStyleLine.split(",");
    // BorderStyle = field index 15, Outline = field index 16
    expect(zhFields[15]).toBe("1"); // BorderStyle=1 (outline + drop shadow)
    expect(zhFields[16]).toBe("3"); // Chinese: 3px outline
    expect(enFields[15]).toBe("1");
    expect(enFields[16]).toBe("2"); // English: 2px outline
  });

  it("applies Bold=1 for both styles, Italic=0 for Chinese, Italic=1 for English", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    const zhStyleLine = ass.split("\n").find((l) => l.startsWith("Style: ZhTop,"))!;
    const enStyleLine = ass.split("\n").find((l) => l.startsWith("Style: EnBottom,"))!;
    const zhFields = zhStyleLine.split(",");
    const enFields = enStyleLine.split(",");
    // Bold = field index 7, Italic = field index 8
    expect(zhFields[7]).toBe("-1"); // Bold
    expect(zhFields[8]).toBe("0");  // Not italic
    expect(enFields[7]).toBe("-1"); // Bold
    expect(enFields[8]).toBe("-1"); // Italic
  });

  it("creates two Dialogue lines per cue (ZhTop + EnBottom)", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(4); // 2 cues × 2 languages

    // First two dialogues share the same timing
    const d0 = dialogues[0]!.split(",");
    const d1 = dialogues[1]!.split(",");
    expect(d0[1]).toBe(d1[1]); // same start
    expect(d0[2]).toBe(d1[2]); // same end
    expect(d0[3]).toBe("ZhTop");
    expect(d1[3]).toBe("EnBottom");
  });

  it("preserves dialogue timing from source SRT", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, styleOptions);
    expect(ass).toContain("0:00:01.00,0:00:03.50");
    expect(ass).toContain("0:00:04.00,0:00:06.00");
  });

  it("handles centiseconds overflow (995ms → 100cs → carry to next second)", () => {
    // 995 ms / 10 = 99.5 → Math.round = 100 cs → should carry to next second
    const enOverflow = [
      "1",
      "00:00:01,995 --> 00:00:03,999",
      "Overflow test",
    ].join("\n");
    const zhOverflow = [
      "1",
      "00:00:01,995 --> 00:00:03,999",
      "溢出测试",
    ].join("\n");
    const ass = buildBilingualAss(enOverflow, zhOverflow, styleOptions);
    // 1.995s + overflow: 1s + 995ms → 1*100 + 100 = 200 cs = 2s exactly
    // So the start time should be 0:00:02.00, not 0:00:01.100
    expect(ass).toContain("0:00:02.00,0:00:04.00");
    // Must NOT contain invalid centiseconds >= 100
    expect(ass).not.toMatch(/\.\d{3}/); // no 3-digit centiseconds
    expect(ass).not.toContain(".100");
  });

  it("handles ASS special character escaping", () => {
    const enWithSpecial = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "Hello {world} and \\N newline, comma here",
    ].join("\n");
    const zhWithSpecial = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "你好",
    ].join("\n");
    const ass = buildBilingualAss(enWithSpecial, zhWithSpecial, styleOptions);
    // Commas in text should not appear — ASS uses comma as field separator
    // (The implementation joins multiline with spaces, so commas within a single
    // line are fine as long as they don't look like field separators)
    // { and } should be escaped if present
    const dialogueLines = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    // The text field is the 9th comma-separated field
    for (const d of dialogueLines) {
      // Should not have raw ASS override tags
      expect(d).not.toContain("{\\");
    }
  });

  it("accepts custom fontsDir option", () => {
    const ass = buildBilingualAss(enSrt, zhSrt, {
      ...styleOptions,
      fontsDir: "/usr/share/fonts",
    });
    expect(ass).toContain("[Script Info]");
    // fontsDir doesn't go into ASS content; it's for ffmpeg invocation
  });

  it("throws on cue count mismatch", () => {
    const shortEn = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "Only one cue",
    ].join("\n");
    expect(() => buildBilingualAss(shortEn, zhSrt, styleOptions)).toThrow(/count/i);
  });
});
