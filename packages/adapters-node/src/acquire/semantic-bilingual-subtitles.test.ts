import { describe, expect, it, vi } from "vitest";
import type { ChatRequest, LlmPort } from "@yt2x/core";
import { auditSubtitleArtifacts } from "./audit-subtitles.js";
import { parseSubtitleBlocks } from "./video-subtitles.js";
import {
  allocateCuesByWeight,
  applySeamCuts,
  buildSeamDisplay,
  compactDenseBlocks,
  ensureEnoughFineCues,
  enforceHardCeiling,
  ensureProtectedTermsPreserved,
  findProtectedSpans,
  findWordTimingsForCue,
  fixFlashCues,
  mergeBriefBlocks,
  mergeShortPieces,
  projectSemanticBilingualSubtitles,
  repairSubtitleArtifacts,
  requestCompactRewrite,
  requestContentAlignedSplit,
  splitLongZh,
  splitWideBlocks,
  visualWidth,
  type SubtitleLayoutMeasurement,
  type WordTiming,
} from "./semantic-bilingual-subtitles.js";

const fitMeasurement = async (srt: string): Promise<SubtitleLayoutMeasurement[]> =>
  parseSubtitleBlocks(srt).map((cue) => ({
    cueIndex: cue.index,
    zhWidth: 200,
    fitWidth: 1024,
    lineCount: 1,
    severity: "fit" as const,
    resolvedFonts: { zh: "PingFang SC", en: "Lexend Deca" },
  }));

/**
 * Builds an LLM mock for the current pipeline: Phase 0a (insertCommas, a
 * jsonMode request whose user content is a JSON array) always echoes the
 * input text unchanged, and Phase 1 (per-sentence translation, a plain-text
 * request) looks up the sentence text in `translations`.
 */
const makePipelineLlm = (translations: Record<string, string>): LlmPort => ({
  chat: vi.fn(async (request: ChatRequest) => {
    const userContent = request.messages[1]!.content as string;

    if (request.jsonMode === true) {
      // Phase 0 repunct: no cuts needed — cues keep their original text.
      return { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" };
    }

    const translated = translations[userContent];
    if (translated === undefined) {
      throw new Error(`no mocked translation for sentence: ${userContent}`);
    }
    return { content: translated, model: "test", finishReason: "stop" };
  }),
});

describe("projectSemanticBilingualSubtitles", () => {
  it("translates a single-sentence source and states the Chinese once in the mono artifact", async () => {
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half.
`;
    const llm = makePipelineLlm({
      "First half second half.": "简短翻译。",
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    // The Chinese sentence spans both English cues on screen, but the
    // mono-Chinese artifact states it once — it is consumed as standalone
    // text (issue #109), where a repeat reads as a stutter.
    expect(parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""))).toEqual(["简短翻译。"]);
    expect(parseSubtitleBlocks(result.enSrt).map((b) => b.text.join(""))).toEqual([
      "First half",
      "second half.",
    ]);
    // Projection is not a delivery verdict; the artifact audit owns quality.
    expect(result.groups).toEqual([]);
    expect(result).not.toHaveProperty("quality");
  });

  it("keeps the merged Chinese cue spanning the full time range it was split across", async () => {
    // issue #109：合并不能丢时间。中文原本被复制进两片英文，合并后这一条
    // 必须覆盖 [第一片起点, 最后一片终点] 的完整跨度，否则句子会提前消失。
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half.
`;
    const llm = makePipelineLlm({ "First half second half.": "简短翻译。" });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zh = parseSubtitleBlocks(result.zhSrt);
    expect(zh).toHaveLength(1);
    expect(zh[0]?.start).toBe("00:00:00,000");
    expect(zh[0]?.end).toBe("00:00:03,000");
  });

  it("leaves the bilingual artifact repeating the Chinese across each English cue", async () => {
    // issue #109 只改中文单语产物。双语观感必须原样：中文在英文分片期间
    // 持续显示，是期望行为，不是缺陷。
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half.
`;
    const llm = makePipelineLlm({ "First half second half.": "简短翻译。" });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    expect(parseSubtitleBlocks(result.bilingualSrt).map((b) => b.text)).toEqual([
      ["简短翻译。", "First half"],
      ["简短翻译。", "second half."],
    ]);
  });

  it("produces three artifacts the audit accepts together", async () => {
    // 这条覆盖的是投影与审计之间的缝：两边单测各自全绿，拼起来却不成立。
    // issue #109 的第一版修复就栽在这里——中文单语合并后，审计按「三份逐下标
    // 时间窗全等」判定，每个下标都报 content 级 bilingual-timing，整条交付被
    // 判失败，而两侧的单测一个都没红。
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half.
`;
    const llm = makePipelineLlm({ "First half second half.": "简短翻译。" });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const audit = auditSubtitleArtifacts({
      sourceSrt,
      enSrt: result.enSrt,
      zhSrt: result.zhSrt,
      bilingualSrt: result.bilingualSrt,
      manifest: { sourceSha256: result.sourceSha256 },
      measurements: await fitMeasurement(result.bilingualSrt),
    });

    expect(audit.issues).toEqual([]);
    expect(audit.verdict).toBe("pass");
  });

  it("does not merge the same sentence when another sentence separates the two runs", async () => {
    // 只折叠「紧邻」重复。同一句话在片子里再次出现是正常的，不该被吞掉。
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
Right.

2
00:00:01,500 --> 00:00:03,000
Something else entirely.

3
00:00:03,000 --> 00:00:04,500
Right.
`;
    const llm = makePipelineLlm({
      "Right.": "对。",
      "Something else entirely.": "完全是另一回事。",
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    expect(parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""))).toEqual([
      "对。",
      "完全是另一回事。",
      "对。",
    ]);
  });

  it("starts a new sentence after sentence-ending punctuation", async () => {
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,500
First half

2
00:00:01,500 --> 00:00:03,000
second half.

3
00:00:03,200 --> 00:00:04,500
Another

4
00:00:04,500 --> 00:00:06,000
complete thought.
`;
    const llm = makePipelineLlm({
      "First half second half.": "第一句翻译。",
      "Another complete thought.": "第二句翻译。",
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    // One entry per sentence: each spans its two English cues (issue #109).
    expect(parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""))).toEqual([
      "第一句翻译。",
      "第二句翻译。",
    ]);
  });

  it("splits a long sentence's translation across its cues instead of repeating the whole thing", async () => {
    // 4 fine cues in one sentence, translation well over FIT_CJK (16).
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,000
One

2
00:00:01,000 --> 00:00:02,000
two

3
00:00:02,000 --> 00:00:03,000
three

4
00:00:03,000 --> 00:00:04,000
four.
`;
    const longZh = "这是一句很长的中文翻译，包含了超过十六个字符，需要被拆分成多个部分显示。";
    const llm = makePipelineLlm({
      "One two three four.": longZh,
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""));
    // Three punctuation-delimited fragments over four English cues — the
    // mono artifact lists each fragment once (issue #109), so a fragment
    // that spanned two cues is still one entry here.
    expect(zhTexts).toHaveLength(3);
    // Not every cue repeats the identical full sentence — it was split.
    expect(new Set(zhTexts).size).toBeGreaterThan(1);
    // Splitting must not lose text: the fragments still rebuild the sentence.
    expect(zhTexts.join("")).toBe(longZh);
    // Each part stays under a generous bound; no single cue keeps the whole 36-char sentence.
    for (const text of zhTexts) {
      expect(text.length).toBeLessThan(longZh.length);
    }
  });

  it("falls back to a single merged block when the single source cue is too short to spare a second of speech and the LLM align attempt yields nothing usable", async () => {
    // makePipelineLlm's generic jsonMode handler answers every jsonMode call
    // (repunct AND the align-rewrite fallback) with a repunct-shaped
    // response, so the align attempt here deliberately gets back something
    // with no usable "pieces" field — exercising the graceful-degradation
    // path rather than a successful rewrite.
    const sourceSrt = `1
00:00:00,000 --> 00:00:02,000
One cue only.
`;
    const longZh = "这是一句非常长的中文翻译超过十六个字符但只有一个源字幕无法拆分显示。";
    const llm = makePipelineLlm({
      "One cue only.": longZh,
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""));
    expect(zhTexts).toEqual([longZh]);
  });

  it("preserves a translated cue shorter than 0.3 seconds for the audit layer", async () => {
    const sourceSrt = `1
00:00:00,000 --> 00:00:00,200
Flash.
`;
    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm: makePipelineLlm({ "Flash.": "闪现。" }),
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    expect(parseSubtitleBlocks(result.enSrt)).toEqual([
      expect.objectContaining({
        start: "00:00:00,000",
        end: "00:00:00,200",
        text: ["Flash."],
      }),
    ]);
    expect(parseSubtitleBlocks(result.zhSrt)[0]?.text).toEqual(["闪现。"]);
  });

  it("asks the LLM for a compact rewrite when even a full re-split can't fit the available cues, and uses it when valid", async () => {
    const sourceSrt = `1
00:00:00,000 --> 00:00:02,000
One cue only.
`;
    const longZh = "这是一句非常长的中文翻译超过十六个字符但只有一个源字幕无法拆分显示。";
    const compactZh = "更简洁的译文";
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (request.jsonMode === true && userContent.includes("pieceCount")) {
          // The align-rewrite fallback call.
          return {
            content: JSON.stringify({ pieces: [compactZh] }),
            model: "test",
            finishReason: "stop",
          };
        }
        if (request.jsonMode === true) {
          // Phase 0 repunct: no cuts needed.
          return { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" };
        }
        return { content: longZh, model: "test", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""));
    expect(zhTexts).toEqual([compactZh]);
  });

  it("splits a single long source cue into more display slots when it has enough words and duration to spare", async () => {
    // Regression test: a real DeepSeek run produced a 21.5-visual-width block
    // from exactly this shape — one sentence, one long fine cue with plenty
    // of speech to split, but the old code never even tried because it was a
    // single cue.
    const sourceSrt = `1
00:00:00,000 --> 00:00:04,160
You get me to answer your questions in office hours and in the Discord chat.
`;
    const longZh = "测".repeat(44);
    const llm = makePipelineLlm({
      "You get me to answer your questions in office hours and in the Discord chat.": longZh,
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""));
    expect(zhTexts.length).toBeGreaterThan(1);
    for (const text of zhTexts) {
      expect(visualWidth(text)).toBeLessThanOrEqual(20);
    }
    expect(zhTexts.join("")).toBe(longZh);
  });

  it("splits both the translation and the underlying source cues to respect the hard ceiling when too few cues exist", async () => {
    // Only 2 source cues, but the translation is long enough that distributing
    // it across just 2 slots would blow the 20-char hard ceiling (44/2=22).
    const sourceSrt = `1
00:00:00,000 --> 00:00:03,000
one two three four five six seven eight

2
00:00:03,000 --> 00:00:06,000
nine ten eleven twelve thirteen fourteen.
`;
    const longZh = "测".repeat(44);
    const llm = makePipelineLlm({
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen.": longZh,
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((b) => b.text.join(""));
    // Grew from 2 source cues to 4 display slots so every piece fits.
    expect(zhTexts).toHaveLength(4);
    for (const text of zhTexts) {
      expect(visualWidth(text)).toBeLessThanOrEqual(20);
    }
    expect(zhTexts.join("")).toBe(longZh);
  });

  it("distributes cues proportionally to each translated part's length instead of dumping the remainder on the last part", async () => {
    // Regression: real DeepSeek output showed a 2-character closing
    // fragment ("了。") alone for 6 consecutive blocks because the old
    // floor-division allocation gave 100% of the leftover cues to
    // whichever part happened to come last, regardless of its own length.
    // 7 fine cues (1s each) covering one sentence.
    const sourceSrt = `1
00:00:00,000 --> 00:00:01,000
one two

2
00:00:01,000 --> 00:00:02,000
three four

3
00:00:02,000 --> 00:00:03,000
five six

4
00:00:03,000 --> 00:00:04,000
seven eight

5
00:00:04,000 --> 00:00:05,000
nine ten

6
00:00:05,000 --> 00:00:06,000
eleven twelve

7
00:00:06,000 --> 00:00:07,000
thirteen fourteen.
`;
    // splitLongZh will find the "。" near the end and cut there, producing a
    // large first part (17 chars) and a tiny last part (1 char) — matching
    // the real "了。"-style trailing fragment.
    const zh = `${"测".repeat(16)}。了`;
    const llm = makePipelineLlm({
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen.": zh,
    });

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    // How many cues each fragment occupies is a per-cue display property, so
    // it is read off the bilingual artifact — the mono artifact deliberately
    // states each fragment once regardless of how many cues it spans (#109).
    const zhTexts = parseSubtitleBlocks(result.bilingualSrt).map((b) => b.text[0]!);
    expect(zhTexts).toHaveLength(7);
    const uniqueTexts = [...new Set(zhTexts)];
    expect(uniqueTexts).toHaveLength(2);
    const counts = uniqueTexts.map((t) => zhTexts.filter((x) => x === t).length);
    const widths = uniqueTexts.map((t) => visualWidth(t));
    const shorterIdx = widths[0]! < widths[1]! ? 0 : 1;
    const longerIdx = 1 - shorterIdx;
    // The shorter (trailing) fragment must not absorb most of the cues just
    // because it comes last — it should get close to its fair share.
    expect(counts[shorterIdx]).toBeLessThanOrEqual(2);
    expect(counts[longerIdx]).toBeGreaterThan(counts[shorterIdx]!);
  });

  it("keeps a protected term's Chinese and English on the same cue instead of the length-proportional split putting it on the wrong one", async () => {
    // Regression: a real DeepSeek run showed "Discord" appear in the Chinese
    // shown on the cue BEFORE the English cue that actually says "Discord
    // chat" (same shape for "PRD" and "Grill with Docs" elsewhere in the
    // same video). The old split has no idea which English cue a Chinese
    // fragment's content came from — it only knows the two parts' relative
    // character weight — so a term reliably lands on the wrong side whenever
    // the weight ratio doesn't match where the term is actually spoken.
    const sourceSrt = `1
00:00:00,000 --> 00:00:02,000
You get me to answer your questions in office hours

2
00:00:02,000 --> 00:00:04,000
and in the Discord chat.
`;
    const zhFull = "你在办公时间和Discord聊天里让我回答你的问题。";
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (request.jsonMode === true && userContent.includes("zhTranslation")) {
          // Content-aligned split: cue 1 covers "office hours" (Discord not
          // mentioned yet), cue 2 covers "and in the Discord chat."
          return {
            content: JSON.stringify({
              pieces: [
                { throughCue: 1, text: "你在办公时间" },
                { throughCue: 2, text: "和Discord聊天里让我回答你的问题。" },
              ],
            }),
            model: "test",
            finishReason: "stop",
          };
        }
        if (request.jsonMode === true) {
          return { content: JSON.stringify({ cues: [] }), model: "test", finishReason: "stop" };
        }
        return { content: zhFull, model: "test", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const blocks = parseSubtitleBlocks(result.bilingualSrt);
    const discordEnBlock = blocks.find((b) => b.text[1]?.includes("Discord"));
    expect(discordEnBlock?.text[0]).toContain("Discord");
  });

  it("inserts commas via the LLM then splits deterministically at them, producing multiple output cues from one source cue", async () => {
    const sourceSrt = `1
00:00:00,000 --> 00:00:04,000
one two three four five six seven eight nine ten eleven twelve.
`;
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        if (request.jsonMode === true) {
          // Insert a comma after the 6th word ("six", seam id 5).
          return {
            content: JSON.stringify({ cues: [{ idx: 0, cuts: [{ id: "5", mark: "," }] }] }),
            model: "test",
            finishReason: "stop",
          };
        }
        return { content: "拆分后的翻译。", model: "test", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const enTexts = parseSubtitleBlocks(result.enSrt).map((b) => b.text.join(""));
    expect(enTexts).toHaveLength(2);
    expect(enTexts[0]).toBe("one two three four five six,");
    expect(enTexts[1]).toBe("seven eight nine ten eleven twelve.");
  });

  it("merges a leading one-word comma fragment forward instead of leaving it as an isolated flash cue", async () => {
    // A comma right after the first word (e.g. "You,") has no predecessor to
    // absorb it under backward-only merging, and would otherwise survive as
    // its own single-word cue. It should instead merge into its right
    // neighbor, matching how a trailing short fragment already merges left.
    const sourceSrt = `1
00:00:00,000 --> 00:00:04,000
You using the grill me skill need to be good at planning.
`;
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        if (request.jsonMode === true) {
          // Comma after "You" (seam id 0) and after "skill" (seam id 5).
          return {
            content: JSON.stringify({
              cues: [{ idx: 0, cuts: [{ id: "0", mark: "," }, { id: "5", mark: "," }] }],
            }),
            model: "test",
            finishReason: "stop",
          };
        }
        return { content: "翻译。", model: "test", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const enTexts = parseSubtitleBlocks(result.enSrt).map((b) => b.text.join(""));
    expect(enTexts).not.toContain("You,");
    expect(enTexts[0]).toBe("You, using the grill me skill,");
    expect(enTexts[1]).toBe("need to be good at planning.");
  });

  it("does not treat 'sometimes' as the conjunction 'so' when picking a clause-split boundary", async () => {
    // The >8-word mechanical fallback bisects at a CLAUSE_BOUNDARY_WORDS
    // match near the midpoint. Without a word-boundary anchor, the "so"
    // alternative prefix-matches "sometimes" (also "software", "without"
    // matching "with", etc.), misidentifying it as a clause-starter and
    // splitting right before it — isolating a near-empty leading fragment
    // exactly like the unfixed leading-comma bug this sits next to.
    const sourceSrt = `1
00:00:00,000 --> 00:00:04,000
However I sometimes hear from people using them nicely about it.
`;
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        if (request.jsonMode === true) {
          // Comma after "However" (seam id 0); period is already the last word.
          return {
            content: JSON.stringify({
              cues: [{ idx: 0, cuts: [{ id: "0", mark: "," }] }],
            }),
            model: "test",
            finishReason: "stop",
          };
        }
        return { content: "翻译。", model: "test", finishReason: "stop" };
      }),
    };

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    const enTexts = parseSubtitleBlocks(result.enSrt).map((b) => b.text.join(""));
    expect(enTexts).not.toContain("However, I");
    for (const text of enTexts) {
      expect(text.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("uses real word timing for the comma-split boundary instead of the proportional-length guess, when available", async () => {
    // 20s cue, 10 words. Word durations are deliberately uneven (front-loaded)
    // so the proportional-by-character-length guess (~10s, since both comma
    // halves are similar text length) differs sharply from the real timing
    // (end of the 5th word "five", which lands at 15s here).
    const sourceSrt = `1
00:00:00,000 --> 00:00:20,000
one two three four five six seven eight nine ten
`;
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        if (request.jsonMode === true) {
          // Comma after "five" (seam id 4), period after "ten" (seam id 9).
          return {
            content: JSON.stringify({
              cues: [{ idx: 0, cuts: [{ id: "4", mark: "," }, { id: "9", mark: "." }] }],
            }),
            model: "test",
            finishReason: "stop",
          };
        }
        return { content: "简短翻译。", model: "test", finishReason: "stop" };
      }),
    };
    const wordTimings: WordTiming[] = [
      { word: "one", start: 0, end: 5 },
      { word: "two", start: 5, end: 9 },
      { word: "three", start: 9, end: 12 },
      { word: "four", start: 12, end: 14 },
      { word: "five", start: 14, end: 15 },
      { word: "six", start: 15, end: 16 },
      { word: "seven", start: 16, end: 17 },
      { word: "eight", start: 17, end: 18 },
      { word: "nine", start: 18, end: 19 },
      { word: "ten", start: 19, end: 20 },
    ];

    const result = await projectSemanticBilingualSubtitles({
      sourceSrt,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
      wordTimings,
    });

    const enBlocks = parseSubtitleBlocks(result.enSrt);
    expect(enBlocks).toHaveLength(2);
    expect(enBlocks[0]!.text.join("")).toBe("one two three four five,");
    expect(enBlocks[0]!.end).toBe("00:00:15,000");
    expect(enBlocks[1]!.start).toBe("00:00:15,000");
  });

  it("processes repunct pages in parallel across multiple pages", async () => {
    // 12 cues, REPUNCT_PAGE_SIZE is 8 → 2 pages.
    const pad = (n: number): string => String(n).padStart(2, "0");
    const cues = Array.from({ length: 12 }, (_, i) =>
      `${i + 1}\n00:00:${pad(i)},000 --> 00:00:${pad(i + 1)},000\nCue number ${i + 1}\n`,
    ).join("\n\n") + "\n";

    const seenPages: number[][] = [];
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (request.jsonMode === true) {
          const page = JSON.parse(userContent) as { idx: number; seams: string }[];
          seenPages.push(page.map((p) => p.idx));
          // Mark only the last cue in each page as sentence-final.
          const last = page[page.length - 1]!;
          const lastSeamId = (last.seams.match(/<@\d+>/gu) ?? []).length - 1;
          return {
            content: JSON.stringify({
              cues: [{ idx: last.idx, cuts: [{ id: String(lastSeamId), mark: "." }] }],
            }),
            model: "test",
            finishReason: "stop",
          };
        }
        return { content: "翻译。", model: "test", finishReason: "stop" };
      }),
    };

    await projectSemanticBilingualSubtitles({
      sourceSrt: cues,
      llm,
      model: "test-model",
      measureLayout: fitMeasurement,
    });

    expect(seenPages).toHaveLength(2);
    expect(seenPages[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(seenPages[1]).toEqual([8, 9, 10, 11]);
  });
});

describe("allocateCuesByWeight", () => {
  it("splits evenly when weights are equal and the total divides cleanly", () => {
    expect(allocateCuesByWeight([1, 1, 1], 6)).toEqual([2, 2, 2]);
  });

  it("gives every part at least 1 even with very skewed weights", () => {
    const result = allocateCuesByWeight([100, 0.5, 0.5], 3);
    expect(result).toEqual([1, 1, 1]);
    expect(result.reduce((s, n) => s + n, 0)).toBe(3);
  });

  it("sums to exactly totalCues even when weights don't divide evenly", () => {
    const result = allocateCuesByWeight([1, 1, 1], 7);
    expect(result.reduce((s, n) => s + n, 0)).toBe(7);
    expect(result.every((n) => n >= 2)).toBe(true);
  });

  it("gives a heavy part noticeably more cues than a light part", () => {
    const result = allocateCuesByWeight([14, 13, 2, 2, 2, 2, 2], 18);
    expect(result.reduce((s, n) => s + n, 0)).toBe(18);
    // Regression: the old floor-division-with-remainder-on-last approach
    // gave the last (lightest) part 6 of the 18 cues just because it came
    // last — real DeepSeek output showed "了。" alone for 6 consecutive
    // blocks. The lightest parts should get close to their fair share (1-2),
    // not absorb the whole remainder.
    expect(result[result.length - 1]).toBeLessThanOrEqual(2);
    expect(result[0]).toBeGreaterThan(result[result.length - 1]!);
  });

  it("handles a single part by giving it every cue", () => {
    expect(allocateCuesByWeight([5], 4)).toEqual([4]);
  });
});

describe("findWordTimingsForCue", () => {
  const timing = (word: string, start: number, end: number): WordTiming => ({ word, start, end });

  it("finds a contiguous match within the time window", () => {
    const all = [timing("hello", 10.0, 10.4), timing("world", 10.4, 10.9), timing("today", 10.9, 11.2)];
    const result = findWordTimingsForCue(["hello", "world"], 10.0, 11.0, all);
    expect(result).toEqual([all[0], all[1]]);
  });

  it("matches case-insensitively and ignores surrounding punctuation on the cue word", () => {
    const all = [timing("hello", 10.0, 10.4), timing("world", 10.4, 10.9)];
    const result = findWordTimingsForCue(["Hello,", "\"World\""], 10.0, 11.0, all);
    expect(result).toEqual([all[0], all[1]]);
  });

  it("returns null when the words don't match anything in the window", () => {
    const all = [timing("hello", 10.0, 10.4), timing("world", 10.4, 10.9)];
    expect(findWordTimingsForCue(["goodbye", "moon"], 10.0, 11.0, all)).toBeNull();
  });

  it("returns null when a matching sequence exists but falls outside the time window", () => {
    const all = [timing("hello", 100.0, 100.4), timing("world", 100.4, 100.9)];
    expect(findWordTimingsForCue(["hello", "world"], 10.0, 11.0, all)).toBeNull();
  });

  it("picks the occurrence that actually falls inside the window when the phrase repeats elsewhere", () => {
    const all = [
      timing("hello", 1.0, 1.4),
      timing("world", 1.4, 1.9),
      timing("hello", 10.0, 10.4),
      timing("world", 10.4, 10.9),
    ];
    const result = findWordTimingsForCue(["hello", "world"], 10.0, 11.0, all);
    expect(result).toEqual([all[2], all[3]]);
  });
});

describe("findProtectedSpans", () => {
  it("protects a bare run of Latin/digit characters even with no glossary given", () => {
    const spans = findProtectedSpans("你好Agents世界", []);
    // "Agents" starts at index 2, ends at index 8 (exclusive).
    expect(spans).toEqual(expect.arrayContaining([[2, 8]]));
  });

  it("protects a multi-word glossary term as a single atomic span", () => {
    const text = "早上用Grill with Docs做教程";
    const spans = findProtectedSpans(text, ["Grill with Docs"]);
    const idx = text.indexOf("Grill with Docs");
    expect(spans).toEqual(expect.arrayContaining([[idx, idx + "Grill with Docs".length]]));
  });

  it("protects a multi-character Chinese word so a split can't land inside it", () => {
    const text = "你得自己把握方向和范围。";
    const spans = findProtectedSpans(text, []);
    const idx = text.indexOf("范围");
    expect(spans).toEqual(expect.arrayContaining([[idx, idx + "范围".length]]));
  });

  it("does not protect single Chinese characters (splitting between them is fine)", () => {
    const spans = findProtectedSpans("你好", []);
    // Neither "你" nor "好" is a multi-character word, so no span should
    // forbid a split between them.
    expect(spans.some(([s, e]) => s === 0 && e === 1)).toBe(false);
    expect(spans.some(([s, e]) => s === 1 && e === 2)).toBe(false);
  });

  it("does not treat Chinese punctuation as part of a protected word", () => {
    const spans = findProtectedSpans("范围，可能", []);
    // "范围" and "可能" are each protected, but the comma between them is not
    // part of either span, so a split right after the comma stays legal.
    expect(spans).toEqual(expect.arrayContaining([[0, 2], [3, 5]]));
  });
});

describe("ensureProtectedTermsPreserved", () => {
  it("returns the translation unchanged when no protected term is missing", async () => {
    const llm: LlmPort = { chat: vi.fn() };

    const result = await ensureProtectedTermsPreserved(
      "where you have a grill with docs,",
      "你拿着Grill with Docs一起过一遍，",
      llm,
      "test-model",
    );

    expect(result).toBe("你拿着Grill with Docs一起过一遍，");
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("retries and uses the fix when the LLM restores the missing term", async () => {
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: "你拿着Grill with Docs一起过一遍，",
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await ensureProtectedTermsPreserved(
      "where you have a grill with docs,",
      "你拿着文档一起过一遍，",
      llm,
      "test-model",
    );

    expect(result).toBe("你拿着Grill with Docs一起过一遍，");
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("keeps the original translation when the retry still doesn't include the term", async () => {
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: "你拿着文档一起过一遍，", // still missing "Grill with Docs"
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await ensureProtectedTermsPreserved(
      "where you have a grill with docs,",
      "你拿着文档一起过一遍，",
      llm,
      "test-model",
    );

    expect(result).toBe("你拿着文档一起过一遍，");
  });

  it("keeps the original translation when the retry call itself rejects", async () => {
    const llm: LlmPort = { chat: vi.fn(async () => { throw new Error("network down"); }) };

    const result = await ensureProtectedTermsPreserved(
      "where you have a grill with docs,",
      "你拿着文档一起过一遍，",
      llm,
      "test-model",
    );

    expect(result).toBe("你拿着文档一起过一遍，");
  });

  it("does not fire for a term that never appears in the English source", async () => {
    const llm: LlmPort = { chat: vi.fn() };

    const result = await ensureProtectedTermsPreserved(
      "just a normal sentence.",
      "普通的一句话。",
      llm,
      "test-model",
    );

    expect(result).toBe("普通的一句话。");
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe("requestCompactRewrite", () => {
  const llmReturning = (content: string): LlmPort => ({
    chat: vi.fn(async () => ({ content, model: "test", finishReason: "stop" })),
  });

  it("returns the pieces when the LLM answers with exactly the requested count, all within budget", async () => {
    const llm = llmReturning(JSON.stringify({ pieces: ["短句一", "短句二"] }));
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toEqual(["短句一", "短句二"]);
  });

  it("returns null when the LLM answers with the wrong number of pieces", async () => {
    const llm = llmReturning(JSON.stringify({ pieces: ["只有一句"] }));
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });

  it("returns null when a piece still exceeds the hard limit", async () => {
    const llm = llmReturning(JSON.stringify({ pieces: ["测".repeat(21), "短"] }));
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });

  it("returns null when a piece is empty", async () => {
    const llm = llmReturning(JSON.stringify({ pieces: ["", "短句二"] }));
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the response is not valid JSON", async () => {
    const llm = llmReturning("not json at all");
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the response has no pieces field", async () => {
    const llm = llmReturning(JSON.stringify({ cues: [] })); // shape from an unrelated repunct mock
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });

  it("returns null instead of throwing when the LLM call itself rejects", async () => {
    const llm: LlmPort = { chat: vi.fn(async () => { throw new Error("network down"); }) };
    const result = await requestCompactRewrite("source text", "原来的长翻译", 2, 20, llm, "test-model");
    expect(result).toBeNull();
  });
});

describe("repairSubtitleArtifacts", () => {
  const srt = (cues: readonly { start: string; end: string; text: string }[]): string =>
    `${cues.map((c, i) => `${i + 1}\n${c.start} --> ${c.end}\n${c.text}`).join("\n\n")}\n`;

  it("fixes a missing protected term without touching anything else", async () => {
    const enSrt = srt([{ start: "00:00:00,000", end: "00:00:02,000", text: "where you have a grill with docs," }]);
    const zhSrt = srt([{ start: "00:00:00,000", end: "00:00:02,000", text: "你拿着文档一起过一遍，" }]);
    const bilingualSrt = srt([
      { start: "00:00:00,000", end: "00:00:02,000", text: "你拿着文档一起过一遍，\nwhere you have a grill with docs," },
    ]);
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: "你拿着Grill with Docs一起过一遍，",
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await repairSubtitleArtifacts({ enSrt, zhSrt, bilingualSrt, llm, model: "test-model" });

    expect(result.changed).toBe(true);
    expect(parseSubtitleBlocks(result.zhSrt)[0]!.text).toEqual(["你拿着Grill with Docs一起过一遍，"]);
    expect(parseSubtitleBlocks(result.bilingualSrt)[0]!.text).toEqual([
      "你拿着Grill with Docs一起过一遍，",
      "where you have a grill with docs,",
    ]);
  });

  it("compacts a cue that reads too fast", async () => {
    const dense = "一二三四五六七八九十一二三四五六七八九十"; // 20 chars / 2s = 10 cps
    const compact = "一二三四五六七八九十";
    const enSrt = srt([{ start: "00:00:00,000", end: "00:00:02,000", text: "a dense sentence" }]);
    const zhSrt = srt([{ start: "00:00:00,000", end: "00:00:02,000", text: dense }]);
    const bilingualSrt = srt([{ start: "00:00:00,000", end: "00:00:02,000", text: `${dense}\na dense sentence` }]);
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: compact }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await repairSubtitleArtifacts({ enSrt, zhSrt, bilingualSrt, llm, model: "test-model" });

    expect(result.changed).toBe(true);
    expect(parseSubtitleBlocks(result.zhSrt)[0]!.text).toEqual([compact]);
  });

  it("reports unchanged when nothing needed repair", async () => {
    const enSrt = srt([{ start: "00:00:00,000", end: "00:00:04,000", text: "a normal sentence." }]);
    const zhSrt = srt([{ start: "00:00:00,000", end: "00:00:04,000", text: "一句普通的话。" }]);
    const bilingualSrt = srt([
      { start: "00:00:00,000", end: "00:00:04,000", text: "一句普通的话。\na normal sentence." },
    ]);
    const llm: LlmPort = { chat: vi.fn() };

    const result = await repairSubtitleArtifacts({ enSrt, zhSrt, bilingualSrt, llm, model: "test-model" });

    expect(result).toEqual({ enSrt, zhSrt, bilingualSrt, changed: false });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("applies a term fix to every cue in an identical-text repeat span, not just one", async () => {
    const enSrt = srt([
      { start: "00:00:00,000", end: "00:00:01,000", text: "and grill" },
      { start: "00:00:01,000", end: "00:00:03,000", text: "with docs have been popular," },
    ]);
    const zhSrt = srt([
      { start: "00:00:00,000", end: "00:00:01,000", text: "文档一起过一遍已经流行了，" },
      { start: "00:00:01,000", end: "00:00:03,000", text: "文档一起过一遍已经流行了，" },
    ]);
    const bilingualSrt = srt([
      { start: "00:00:00,000", end: "00:00:01,000", text: "文档一起过一遍已经流行了，\nand grill" },
      { start: "00:00:01,000", end: "00:00:03,000", text: "文档一起过一遍已经流行了，\nwith docs have been popular," },
    ]);
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: "Grill with Docs一起过一遍已经流行了，",
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await repairSubtitleArtifacts({ enSrt, zhSrt, bilingualSrt, llm, model: "test-model" });

    const zhTexts = parseSubtitleBlocks(result.zhSrt).map((c) => c.text.join(""));
    expect(zhTexts).toEqual([
      "Grill with Docs一起过一遍已经流行了，",
      "Grill with Docs一起过一遍已经流行了，",
    ]);
  });

  it("also rewrites full.en.srt when the only change is a flash-cue timing fix", async () => {
    // A cue with no content issue at all — the sole finding is a flash
    // (0.5s < 1s), fixable purely by absorbing the gap before it. The en/zh/
    // bilingual outputs share cue timing, so all three must move together.
    const enSrt = srt([
      { start: "00:00:00,000", end: "00:00:03,000", text: "a long enough sentence to start." },
      { start: "00:00:03,500", end: "00:00:04,000", text: "Short." },
    ]);
    const zhSrt = srt([
      { start: "00:00:00,000", end: "00:00:03,000", text: "一句开场白。" },
      { start: "00:00:03,500", end: "00:00:04,000", text: "短。" },
    ]);
    const bilingualSrt = srt([
      { start: "00:00:00,000", end: "00:00:03,000", text: "一句开场白。\na long enough sentence to start." },
      { start: "00:00:03,500", end: "00:00:04,000", text: "短。\nShort." },
    ]);
    const llm: LlmPort = { chat: vi.fn() };

    const result = await repairSubtitleArtifacts({ enSrt, zhSrt, bilingualSrt, llm, model: "test-model" });

    expect(result.changed).toBe(true);
    expect(llm.chat).not.toHaveBeenCalled(); // pure timing fix, no LLM call needed
    const enBlocks = parseSubtitleBlocks(result.enSrt);
    expect(enBlocks[1]!.start).toBe("00:00:03,000"); // absorbed the 0.5s gap
    expect(enBlocks[1]!.end).toBe("00:00:04,000");
  });
});

describe("fixFlashCues", () => {
  const block = (start: string, end: string, zhText: string, enText = "x") => ({ start, end, zhText, enText });

  it("absorbs the dead gap before a flash cue, without touching its neighbor", () => {
    const blocks = [
      block("00:00:00,000", "00:00:02,000", "第一句。"),
      block("00:00:02,500", "00:00:03,140", "那咱们开始吧。"), // 0.64s, needs +0.36s; gap before = 0.5s
      block("00:00:03,320", "00:00:05,000", "第三句。"),
    ];

    const result = fixFlashCues(blocks);

    expect(result[1]!.start).toBe("00:00:02,140"); // 0.36s absorbed from the gap
    expect(result[1]!.end).toBe("00:00:03,140");
    expect(result[0]).toEqual(blocks[0]); // untouched
    expect(result[2]).toEqual(blocks[2]); // untouched
  });

  it("borrows from the neighbor with more slack when gaps alone aren't enough", () => {
    const blocks = [
      block("00:00:00,000", "00:00:03,500", "较长的一句，有富余。"), // 3.5s, slack 2.5s
      block("00:00:03,500", "00:00:03,720", "解释一下："), // 0.22s, needs +0.78s, no gaps either side
      block("00:00:03,720", "00:00:04,720", "较短的一句。"), // 1.0s exactly, zero slack
    ];

    const result = fixFlashCues(blocks);

    const dur = (b: { start: string; end: string }) => {
      const [sh, sm, srest] = b.start.split(":");
      const [ss, sms] = srest!.split(",");
      const [eh, em, erest] = b.end.split(":");
      const [es, ems] = erest!.split(",");
      const s = Number(sh) * 3600 + Number(sm) * 60 + Number(ss) + Number(sms) / 1000;
      const e = Number(eh) * 3600 + Number(em) * 60 + Number(es) + Number(ems) / 1000;
      return e - s;
    };

    expect(dur(result[1]!)).toBeCloseTo(1.0, 3);
    // Borrowed only from the neighbor with slack (index 0); the zero-slack
    // neighbor (index 2) is untouched, never pushed below the threshold.
    expect(result[2]).toEqual(blocks[2]);
    expect(dur(result[0]!)).toBeGreaterThanOrEqual(1.0);
  });

  it("never shrinks a donor below the minimum duration", () => {
    const blocks = [
      block("00:00:00,000", "00:00:01,500", "刚好富余0.5秒。"), // 1.5s, slack 0.5s
      block("00:00:01,500", "00:00:01,700", "太短了。"), // 0.2s, needs +0.8s
    ];

    const result = fixFlashCues(blocks);

    const durMs = (b: { start: string; end: string }) => {
      const toMs = (t: string) => {
        const [h, m, rest] = t.split(":");
        const [s, ms] = rest!.split(",");
        return ((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000) + Number(ms);
      };
      return toMs(b.end) - toMs(b.start);
    };
    expect(durMs(result[0]!)).toBeGreaterThanOrEqual(1000); // donor never drops below 1s
  });

  it("never changes any text, only timing", () => {
    const blocks = [
      block("00:00:00,000", "00:00:02,000", "第一句。", "First."),
      block("00:00:02,000", "00:00:02,400", "短。", "Short."),
    ];

    const result = fixFlashCues(blocks);

    expect(result.map((b) => b.zhText)).toEqual(blocks.map((b) => b.zhText));
    expect(result.map((b) => b.enText)).toEqual(blocks.map((b) => b.enText));
  });

  it("extends only the outer edges of an identical-text span, leaving internal cue boundaries alone", () => {
    // Gap before (0.2s) alone isn't enough for the needed 0.5s, so both the
    // before- and after-gaps get used — the clearest way to see both outer
    // edges move while the shared internal boundary at 01,900 stays fixed.
    const blocks = [
      block("00:00:00,000", "00:00:01,300", "前一句。"),
      block("00:00:01,500", "00:00:01,900", "重复的句子。"), // span start
      block("00:00:01,900", "00:00:02,000", "重复的句子。"), // span end, combined 0.5s, needs +0.5s
      block("00:00:02,300", "00:00:03,000", "后一句。"),
    ];

    const result = fixFlashCues(blocks);

    // Internal boundary between the two identical-text cues is untouched.
    expect(result[1]!.end).toBe("00:00:01,900");
    expect(result[2]!.start).toBe("00:00:01,900");
    // Only the span's outer edges moved.
    expect(result[1]!.start).not.toBe(blocks[1]!.start);
    expect(result[2]!.end).not.toBe(blocks[2]!.end);
  });

  it("leaves an already-long-enough cue untouched", () => {
    const blocks = [block("00:00:00,000", "00:00:02,000", "足够长了。")];
    expect(fixFlashCues(blocks)).toEqual(blocks);
  });
});

describe("compactDenseBlocks", () => {
  it("compacts a block that reads too fast, using the rewrite when it's shorter", async () => {
    // 20 chars / 2s = 10 cps > 9.
    const dense = "一二三四五六七八九十一二三四五六七八九十";
    const compact = "一二三四五六七八九十";
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: dense, enText: "a dense sentence" },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: compact }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual([{ ...blocks[0], zhText: compact }]);
  });

  it("leaves a block alone when its visual width reads comfortably, even if its raw character count does not", async () => {
    // The audit measures reading speed in visual width (a Latin letter is
    // half a CJK cell), so a block padded with a kept-as-English term is
    // within budget and must not be sent for a rewrite. Budgeting this in
    // raw characters instead asked the model to shorten a line the audit
    // never flags — and since the term can't be dropped, that request had no
    // satisfiable answer.
    const blocks = [{
      start: "00:00:00,000",
      end: "00:00:02,374",
      zhText: "那你定会爱上我的Air Coding Cohort",
      enText: "You will love my Air Coding Cohort",
    }];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: "短" }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(llm.chat).not.toHaveBeenCalled();
    expect(result).toEqual(blocks);
  });

  it("rejects a compaction that drops a protected term the original text had, keeping the over-cps original instead", async () => {
    // Regression: a real repair run compacted "先Grill with Docs，再原型设计。"
    // down to fit the cps budget, but the rewrite dropped "Grill with Docs"
    // entirely — trading a presentation fix for a content regression
    // (glossary-violation). Content correctness must outrank cps.
    const dense = "先Grill with Docs，然后再做原型设计，接着继续下一步。"; // has the term, over budget
    const droppedTerm = "先做文档，然后原型设计，接着下一步。"; // shorter but the term is gone
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: dense, enText: "grill with docs, then prototype" },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: droppedTerm }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual(blocks);
  });

  it("keeps the original when the rewrite doesn't actually shorten it", async () => {
    const dense = "一二三四五六七八九十一二三四五六七八九十";
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: dense, enText: "a dense sentence" },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: dense }), // no shorter than before
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual(blocks);
  });

  it("keeps the original when the compact rewrite call fails validation", async () => {
    const dense = "一二三四五六七八九十一二三四五六七八九十";
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: dense, enText: "a dense sentence" },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({ content: JSON.stringify({}), model: "test", finishReason: "stop" })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual(blocks);
  });

  it("does not touch a block that already reads comfortably", async () => {
    const blocks = [
      { start: "00:00:00,000", end: "00:00:04,000", zhText: "一二三四", enText: "fine" },
    ];
    const llm: LlmPort = { chat: vi.fn() };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual(blocks);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("does not touch a repeat run whose combined cps is already fine, even if a single 1s slice alone would look too fast", async () => {
    const dense = "一二三四五六七八九十一二三四五六七八九十"; // 20 chars over 2s combined = 10 cps... too fast per-slice at 1s
    const blocks = [
      { start: "00:00:00,000", end: "00:00:01,000", zhText: dense, enText: "part one" },
      { start: "00:00:01,000", end: "00:00:04,000", zhText: dense, enText: "part two" },
    ];
    const llm: LlmPort = { chat: vi.fn() };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual(blocks);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("compacts a whole repeat run when the run's own combined cps is too fast, applying the rewrite to every block in it", async () => {
    // Regression: mergeBriefBlocks got a span-aware fix for the same shape
    // (a run's true reading time is its combined duration, and a fix must
    // apply to every block in the run, not one) — compactDenseBlocks had the
    // identical gap: skipping every block in a run meant a run that's
    // genuinely too fast even over its full combined duration was never
    // eligible for compaction at all.
    const dense = "一二三四五六七八九十一二三四五六七八九十"; // 20 chars
    const compact = "一二三四五六七八九十";
    const blocks = [
      { start: "00:00:00,000", end: "00:00:01,000", zhText: dense, enText: "part one" },
      { start: "00:00:01,000", end: "00:00:02,000", zhText: dense, enText: "part two" },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({ text: compact }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await compactDenseBlocks(blocks, llm, "test-model");

    expect(result).toEqual([
      { ...blocks[0], zhText: compact },
      { ...blocks[1], zhText: compact },
    ]);
  });
});

describe("mergeBriefBlocks", () => {
  it("merges a standalone brief block into its neighbor, keeping each block's own timing and English text", () => {
    // The merge extends the SAME combined Chinese text across both blocks
    // rather than collapsing them into one — this preserves the "one static
    // Chinese caption over several distinct English sub-cues" shape instead
    // of losing the brief block's own English text into a combined block.
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: "第一段", enText: "First part" },
      { start: "00:00:02,000", end: "00:00:02,400", zhText: "你知道吗，", enText: "You know," },
      { start: "00:00:02,400", end: "00:00:04,400", zhText: "第三段内容", enText: "Third part" },
    ];

    const result = mergeBriefBlocks(blocks, 20);

    expect(result).toEqual([
      { start: "00:00:00,000", end: "00:00:02,000", zhText: "第一段", enText: "First part" },
      { start: "00:00:02,000", end: "00:00:02,400", zhText: "你知道吗，第三段内容", enText: "You know," },
      { start: "00:00:02,400", end: "00:00:04,400", zhText: "你知道吗，第三段内容", enText: "Third part" },
    ]);
  });

  it("does NOT touch a block that is part of an identical-text repeat run, even if its own 1-second slice alone would read too fast", () => {
    // Regression: a run of 6 identical-text blocks (one long translated
    // piece correctly spanning several original 1s sub-cues) was getting
    // one of its own repeated blocks flagged as "too fast" when scored
    // against just its own 1-second slice (17 chars / 1s ≈ 17 cps), even
    // though the run's true combined reading time (6s) is fine. Merging
    // that one slice into a neighbor broke the run's uniform text.
    const repeated = "测测测测测测测测测测测测测测测测。"; // 17 chars
    const blocks = [
      { start: "00:00:00,000", end: "00:00:01,000", zhText: repeated, enText: "one" },
      { start: "00:00:01,000", end: "00:00:02,000", zhText: repeated, enText: "two" },
      { start: "00:00:02,000", end: "00:00:03,000", zhText: repeated, enText: "three" },
      { start: "00:00:03,000", end: "00:00:04,000", zhText: "了", enText: "four" },
    ];

    const result = mergeBriefBlocks(blocks, 20);

    expect(result).toEqual(blocks);
  });

  it("merges a whole repeat run into an adjacent span when the run's own combined duration is still too brief", () => {
    // Regression: a real 2-cue run ("Now," on a proportionally-tiny 0.13s
    // slice + its continuation) combined to just under the 1s floor. The
    // per-sentence mergeShortPieces had no earlier block of its own sentence
    // to merge into (it was the sentence's first piece); this cross-sentence
    // pass previously skipped the whole run because EVERY block in it had an
    // identical neighbor, so `isTooBrief` never fired for any of them.
    const run = "如果你喜欢我的教学方式，";
    const blocks = [
      { start: "00:00:08,280", end: "00:00:09,280", zhText: "换掉它们。", enText: "change them." },
      { start: "00:00:09,280", end: "00:00:09,407", zhText: run, enText: "Now," },
      { start: "00:00:09,407", end: "00:00:10,200", zhText: run, enText: "if you like the way I teach," },
    ];

    const result = mergeBriefBlocks(blocks, 20);

    const merged = "换掉它们。如果你喜欢我的教学方式，";
    expect(result).toEqual([
      { start: "00:00:08,280", end: "00:00:09,280", zhText: merged, enText: "change them." },
      { start: "00:00:09,280", end: "00:00:09,407", zhText: merged, enText: "Now," },
      { start: "00:00:09,407", end: "00:00:10,200", zhText: merged, enText: "if you like the way I teach," },
    ]);
  });

  it("skips a merge that would exceed the hard limit and leaves the block as-is", () => {
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: "测".repeat(20), enText: "Long part" },
      { start: "00:00:02,000", end: "00:00:02,400", zhText: "你知道吗，", enText: "You know," },
    ];

    const result = mergeBriefBlocks(blocks, 20);

    expect(result).toEqual(blocks);
  });

  it("does not touch blocks that already read comfortably", () => {
    const blocks = [
      { start: "00:00:00,000", end: "00:00:02,000", zhText: "第一段", enText: "First part" },
      { start: "00:00:02,000", end: "00:00:04,000", zhText: "第二段", enText: "Second part" },
    ];

    const result = mergeBriefBlocks(blocks, 20);

    expect(result).toEqual(blocks);
  });
});

describe("mergeShortPieces", () => {
  const cue = (start: string, end: string): { start: string; end: string; text: string[] } => ({
    start,
    end,
    text: ["placeholder"],
  });

  it("merges a too-brief piece into the next piece when it fits the hard limit", () => {
    // Piece 1 covers only cue 1 (00:00:00.000-00:00:00.400 = 0.4s, under the
    // 1s floor) — a real shape for a short clause like "现在，" landing on a
    // brief original ASR cue.
    const cues = [
      cue("00:00:00,000", "00:00:00,400"),
      cue("00:00:00,400", "00:00:02,000"),
    ];
    const pieces = [
      { throughCue: 1, zhText: "现在，" },
      { throughCue: 2, zhText: "如果你喜欢我的教学方式，" },
    ];

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual([{ throughCue: 2, zhText: "现在，如果你喜欢我的教学方式，" }]);
  });

  it("merges into the previous piece when the next merge would exceed the hard limit", () => {
    const cues = [
      cue("00:00:00,000", "00:00:02,000"),
      cue("00:00:02,000", "00:00:02,400"),
    ];
    const pieces = [
      { throughCue: 1, zhText: "第一段内容比较长占了大半空间" }, // 14 wide
      { throughCue: 2, zhText: "太短了" }, // piece 2 is the brief one (0.4s)
    ];
    // Merging piece 2 forward isn't possible (it's the last piece), so it
    // must merge backward into piece 1. Combined width (14+3=17) fits 20.

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual([{ throughCue: 2, zhText: "第一段内容比较长占了大半空间太短了" }]);
  });

  it("merges a piece that reads too fast even when its own duration is at least a second", () => {
    const cues = [
      cue("00:00:00,000", "00:00:01,200"), // 1.2s — passes the duration floor
      cue("00:00:01,200", "00:00:03,000"),
    ];
    const wide = "一二三四五六七八九十一二三"; // 13 chars / 1.2s ≈ 10.8 cps > 9
    const pieces = [
      { throughCue: 1, zhText: wide },
      { throughCue: 2, zhText: "接下来的内容" },
    ];

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual([{ throughCue: 2, zhText: `${wide}接下来的内容` }]);
  });

  it("leaves a too-brief piece alone when no direction fits the hard limit", () => {
    const cues = [
      cue("00:00:00,000", "00:00:00,400"),
      cue("00:00:00,400", "00:00:02,000"),
    ];
    const pieces = [
      { throughCue: 1, zhText: "现在，" },
      // Neighbor is already right at the hard limit — merging would blow it.
      { throughCue: 2, zhText: "测".repeat(20) },
    ];

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual(pieces);
  });

  it("does not touch pieces that already read comfortably", () => {
    const cues = [
      cue("00:00:00,000", "00:00:02,000"),
      cue("00:00:02,000", "00:00:04,000"),
    ];
    const pieces = [
      { throughCue: 1, zhText: "第一段" },
      { throughCue: 2, zhText: "第二段" },
    ];

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual(pieces);
  });

  it("passes a single piece through unchanged", () => {
    const cues = [cue("00:00:00,000", "00:00:00,200")];
    const pieces = [{ throughCue: 1, zhText: "现在，" }];

    const result = mergeShortPieces(pieces, cues, 20);

    expect(result).toEqual(pieces);
  });
});

describe("requestContentAlignedSplit", () => {
  const cues = [
    { start: "00:00:00,000", end: "00:00:02,000", text: ["first cue text"] },
    { start: "00:00:02,000", end: "00:00:04,000", text: ["second cue text"] },
  ];

  it("returns pieces unchanged when every piece already fits the hard limit", async () => {
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          pieces: [
            { throughCue: 1, text: "第一段" },
            { throughCue: 2, text: "第二段" },
          ],
        }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await requestContentAlignedSplit(cues, "第一段第二段", 20, llm, "test-model");

    expect(result).toEqual([
      { throughCue: 1, zhText: "第一段" },
      { throughCue: 2, zhText: "第二段" },
    ]);
    // Only the alignment call — no compaction needed.
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("compacts a piece that comes back over the hard limit instead of rejecting the whole split", async () => {
    const overWidth = "测".repeat(25); // 25 visual cells, over a 20 limit
    const compacted = "测".repeat(18);
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (userContent.includes("pieceCount")) {
          return {
            content: JSON.stringify({ pieces: [compacted] }),
            model: "test",
            finishReason: "stop",
          };
        }
        return {
          content: JSON.stringify({
            pieces: [{ throughCue: 1, text: "第一段" }, { throughCue: 2, text: overWidth }],
          }),
          model: "test",
          finishReason: "stop",
        };
      }),
    };

    const result = await requestContentAlignedSplit(
      cues,
      `第一段${overWidth}`,
      20,
      llm,
      "test-model",
    );

    expect(result).toEqual([
      { throughCue: 1, zhText: "第一段" },
      { throughCue: 2, zhText: compacted },
    ]);
  });

  it("keeps the original over-width piece when compaction fails and its span is a single cue", async () => {
    const overWidth = "测".repeat(25);
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (userContent.includes("pieceCount")) {
          // Compact rewrite fails validation (wrong piece count).
          return { content: JSON.stringify({ pieces: [] }), model: "test", finishReason: "stop" };
        }
        return {
          content: JSON.stringify({
            pieces: [{ throughCue: 1, text: "第一段" }, { throughCue: 2, text: overWidth }],
          }),
          model: "test",
          finishReason: "stop",
        };
      }),
    };

    const result = await requestContentAlignedSplit(
      cues,
      `第一段${overWidth}`,
      20,
      llm,
      "test-model",
    );

    // Compaction failed and the piece covers exactly one cue, so there is no
    // second display slot to re-split it into (see the multi-cue case above).
    // The content-correct alignment is still returned over budget rather than
    // thrown away — falling back to the weight-based split could misplace
    // content again, and the audit's width check reports what did ship.
    expect(result).toEqual([
      { throughCue: 1, zhText: "第一段" },
      { throughCue: 2, zhText: overWidth },
    ]);
  });

  it("re-splits an over-width piece across its own cues when compaction fails", async () => {
    // The real failure this covers: DeepSeek returned ONE piece covering all
    // of a sentence's cues, so every cue in the span showed the same 44-cell
    // Chinese line. Compaction can't help an enumeration like this (there is
    // no shorter way to say nine code smells), and keeping the original meant
    // an unreadable block shipped — the SRT stage has no layout measurements,
    // so the audit's hard-layout check never saw it either.
    const enumeration = "比如神秘命名、重复代码、依恋情结、数据泥团、基本类型偏执、发散式变化、夸夸其谈通用性、消息链。";
    const fiveCues = [
      { start: "00:00:00,000", end: "00:00:01,000", text: ["what I want to do is invoke the"] },
      { start: "00:00:01,000", end: "00:00:02,000", text: ["idea of a mysterious name or duplicated"] },
      { start: "00:00:02,000", end: "00:00:03,000", text: ["code or feature envy, data clumps,"] },
      { start: "00:00:03,000", end: "00:00:04,000", text: ["primitive obsession, divergent change,"] },
      { start: "00:00:04,000", end: "00:00:05,000", text: ["speculative generality, message chains."] },
    ];
    const llm: LlmPort = {
      chat: vi.fn(async (request: ChatRequest) => {
        const userContent = request.messages[1]!.content as string;
        if (userContent.includes("pieceCount")) {
          // Compaction can't shrink an enumeration of protected concepts.
          return { content: JSON.stringify({ pieces: [] }), model: "test", finishReason: "stop" };
        }
        return {
          content: JSON.stringify({ pieces: [{ throughCue: 5, text: enumeration }] }),
          model: "test",
          finishReason: "stop",
        };
      }),
    };

    const result = await requestContentAlignedSplit(fiveCues, enumeration, 20, llm, "test-model");

    expect(result).not.toBeNull();
    // Every piece now fits the display budget...
    for (const piece of result!) {
      expect(visualWidth(piece.zhText)).toBeLessThanOrEqual(20);
    }
    // ...the pieces still cover every cue in order, with no gaps...
    expect(result!.length).toBeGreaterThan(1);
    expect(result![result!.length - 1]!.throughCue).toBe(5);
    expect(result!.map((p) => p.throughCue)).toEqual(
      [...result!.map((p) => p.throughCue)].sort((a, b) => a - b),
    );
    // ...and no content was dropped or invented along the way.
    expect(result!.map((p) => p.zhText).join("")).toBe(enumeration);
  });

  it("still rejects a response with broken cue coverage even though width is no longer checked upfront", async () => {
    const llm: LlmPort = {
      chat: vi.fn(async () => ({
        // Gap: doesn't cover cue 2 at all.
        content: JSON.stringify({ pieces: [{ throughCue: 1, text: "第一段" }] }),
        model: "test",
        finishReason: "stop",
      })),
    };

    const result = await requestContentAlignedSplit(cues, "第一段第二段", 20, llm, "test-model");
    expect(result).toBeNull();
  });
});

describe("splitWideBlocks", () => {
  const block = (start: string, end: string, zhText: string, enText: string) =>
    ({ start, end, zhText, enText });

  it("re-splits a run of identical over-width text across the cues it already occupies", () => {
    // The shipped shape: one 44-cell line repeated over five cues.
    const enumeration = "比如神秘命名、重复代码、依恋情结、数据泥团、基本类型偏执、发散式变化、夸夸其谈通用性、消息链。";
    const blocks = [
      block("00:00:00,000", "00:00:01,000", enumeration, "first"),
      block("00:00:01,000", "00:00:02,000", enumeration, "second"),
      block("00:00:02,000", "00:00:03,000", enumeration, "third"),
      block("00:00:03,000", "00:00:04,000", enumeration, "fourth"),
      block("00:00:04,000", "00:00:05,000", enumeration, "fifth"),
    ];

    const result = splitWideBlocks(blocks, 20);

    for (const b of result) expect(visualWidth(b.zhText)).toBeLessThanOrEqual(20);
    // Timing and English are untouched; only the Chinese is redistributed.
    expect(result.map((b) => [b.start, b.end, b.enText])).toEqual(
      blocks.map((b) => [b.start, b.end, b.enText]),
    );
    // No content dropped or invented: consecutive distinct pieces, in order,
    // concatenate back to the original line.
    const distinct = result.map((b) => b.zhText).filter((t, i, all) => i === 0 || all[i - 1] !== t);
    expect(distinct.join("")).toBe(enumeration);
    expect(distinct.length).toBeGreaterThan(1);
  });

  it("leaves a run alone when it already fits", () => {
    const blocks = [
      block("00:00:00,000", "00:00:01,000", "短句一。", "first"),
      block("00:00:01,000", "00:00:02,000", "短句二。", "second"),
    ];

    expect(splitWideBlocks(blocks, 20)).toEqual(blocks);
  });

  it("keeps an over-width run intact when it has fewer cues than the split needs", () => {
    // One cue, nowhere to put a second piece — content wins over budget.
    const wide = "测".repeat(44);
    const blocks = [block("00:00:00,000", "00:00:02,000", wide, "only")];

    expect(splitWideBlocks(blocks, 20)).toEqual(blocks);
  });
});

describe("buildSeamDisplay", () => {
  it("marks a seam id after every word", () => {
    expect(buildSeamDisplay(["hello", "world", "today"])).toBe("hello<@0> world<@1> today<@2>");
  });

  it("handles a single word", () => {
    expect(buildSeamDisplay(["hello"])).toBe("hello<@0>");
  });
});

describe("applySeamCuts", () => {
  const words = ["hello", "world", "today"];

  it("returns the words unchanged when there are no cuts", () => {
    expect(applySeamCuts(words, [])).toBe("hello world today");
  });

  it("inserts a mark right after the targeted word", () => {
    expect(applySeamCuts(words, [{ id: "1", mark: "," }])).toBe("hello world, today");
  });

  it("applies multiple cuts at different seams", () => {
    expect(applySeamCuts(words, [{ id: "0", mark: "," }, { id: "2", mark: "." }])).toBe(
      "hello, world today.",
    );
  });

  it("ignores a cut whose id is out of range", () => {
    expect(applySeamCuts(words, [{ id: "99", mark: "," }])).toBe("hello world today");
  });

  it("ignores a cut whose id is not a valid integer", () => {
    expect(applySeamCuts(words, [{ id: "abc", mark: "," }])).toBe("hello world today");
  });

  it("ignores a cut with an unrecognized mark", () => {
    expect(applySeamCuts(words, [{ id: "1", mark: "@" }])).toBe("hello world today");
  });

  it("does not add a duplicate mark when the word already ends with punctuation", () => {
    // Regression: a YouTube caption word can already carry punctuation
    // (e.g. "them,"); a cut at that seam must not double it up to "them,,".
    const alreadyPunctuated = ["I", "hear", "from", "people", "using", "them,"];
    const result = applySeamCuts(alreadyPunctuated, [{ id: "5", mark: "," }]);
    expect(result).toBe("I hear from people using them,");
  });

  it("still applies a mark to a word that has no existing trailing punctuation", () => {
    const result = applySeamCuts(["them"], [{ id: "0", mark: "," }]);
    expect(result).toBe("them,");
  });

  it("never alters or drops a word, even with garbage cuts mixed in", () => {
    const result = applySeamCuts(words, [
      { id: "1", mark: "," },
      { id: "-1", mark: "," },
      { id: "5", mark: "." },
    ]);
    expect(result.replace(/[,.]/gu, "")).toBe("hello world today");
  });
});

describe("visualWidth", () => {
  it("counts each CJK character as one full cell", () => {
    expect(visualWidth("你好世界")).toBe(4);
  });

  it("counts each Latin letter or digit as half a cell", () => {
    expect(visualWidth("Codex2")).toBe(3);
  });

  it("ignores whitespace and punctuation entirely", () => {
    expect(visualWidth("你好，世界！")).toBe(4);
    expect(visualWidth("a, b.")).toBe(1);
  });

  it("weighs mixed CJK+Latin text as the sum of both", () => {
    // "你好" = 2 CJK cells, "Codex" = 5 Latin letters * 0.5 = 2.5 cells.
    expect(visualWidth("你好Codex")).toBe(4.5);
  });
});

describe("enforceHardCeiling", () => {
  const HARD_CJK = 20;

  it("leaves a part unchanged when it is already at or under the limit", () => {
    const parts = ["测".repeat(HARD_CJK)];
    expect(enforceHardCeiling(parts, HARD_CJK)).toEqual(parts);
  });

  it("splits an over-limit part with natural punctuation into pieces that all fit", () => {
    const longPart =
      "这是一句非常长的中文翻译，包含了超过二十个字符，需要被拆分成多个部分显示，才能满足硬性上限的要求。";
    const result = enforceHardCeiling([longPart], HARD_CJK);

    expect(result.length).toBeGreaterThan(1);
    for (const piece of result) {
      expect(visualWidth(piece)).toBeLessThanOrEqual(HARD_CJK);
    }
    // No content lost: concatenating the pieces reconstructs the source text.
    expect(result.join("")).toBe(longPart);
  });

  it("force-splits an over-limit part even without any punctuation", () => {
    const runOn = "测".repeat(44);
    const result = enforceHardCeiling([runOn], HARD_CJK);

    expect(result.length).toBeGreaterThan(1);
    for (const piece of result) {
      expect(visualWidth(piece)).toBeLessThanOrEqual(HARD_CJK);
    }
    expect(result.join("")).toBe(runOn);
  });

  it("passes already-short parts through untouched alongside a split long one", () => {
    const shortPart = "短句。";
    const longPart = "测".repeat(44);
    const result = enforceHardCeiling([shortPart, longPart], HARD_CJK);

    expect(result[0]).toBe(shortPart);
    expect(result.length).toBeGreaterThan(2);
  });

  it("never cuts through an embedded English word, even when the natural split point falls inside it", () => {
    // No CJK punctuation anywhere, so the fallback split point is a raw
    // character offset — which lands squarely inside "Agents" (chars 10-15
    // of this 26-char string) unless the split is nudged out of it.
    const runOn = `${"测".repeat(10)}Agents${"测".repeat(10)}`;
    const result = enforceHardCeiling([runOn], HARD_CJK);

    expect(result.join("")).toBe(runOn);
    expect(result.some((p) => p.includes("Agents"))).toBe(true);
    for (const piece of result) {
      expect(visualWidth(piece)).toBeLessThanOrEqual(HARD_CJK);
    }
  });

  it("never cuts through an ordinary Chinese word, even when the natural split point falls inside it", () => {
    // Regression: real DeepSeek output split "范围" into "范"+"围" across two
    // blocks. No punctuation anywhere, so the fallback split point is a raw
    // character offset (11) that lands squarely inside "范围" (chars 10-11
    // of this 21-char string) unless the split is nudged out of it.
    const runOn = `${"测".repeat(10)}范围${"测".repeat(9)}`;
    const result = enforceHardCeiling([runOn], HARD_CJK);

    expect(result.join("")).toBe(runOn);
    expect(result.some((p) => p.includes("范围"))).toBe(true);
    for (const piece of result) {
      expect(visualWidth(piece)).toBeLessThanOrEqual(HARD_CJK);
    }
  });
});

describe("splitLongZh", () => {
  it("never cuts through a protected word even when the nudge would land below the minimum split-index floor", () => {
    // Regression: nudging nudgeOutOfProtectedSpans() correctly moves the
    // split point to 3 (right before "范围"), but the split point is then
    // separately clamped to a minimum of 4 (Math.max(4, ...)) — which lands
    // squarely back inside the word (index 4 is strictly between "范"(3) and
    // "围"(5)). This exact shape (word near the very start of a multi-part
    // split) reproduced in real DeepSeek output across several videos.
    const zh = `${"测".repeat(3)}范围${"测".repeat(15)}`; // 20 chars total
    const result = splitLongZh(zh, 5);

    expect(result.join("")).toBe(zh);
    expect(result.some((p) => p.includes("范围"))).toBe(true);
    expect(result.some((p) => p.endsWith("范"))).toBe(false);
  });

  it("widens the search past the cosmetic min-fragment-size preference when that's the only way to escape a word", () => {
    // Regression: after fixing the case above, a brute-force sweep found a
    // narrower failure mode — when the preferred [4, len-2] window shrinks
    // to a single point that lands inside the word, the old code gave up
    // and split it anyway. An intact word matters more than the "≥4 chars"
    // cosmetic preference, so this must widen the search instead.
    const zh = `${"测".repeat(18)}范围${"测".repeat(1)}`; // 21 chars total
    const result = splitLongZh(zh, 5);

    expect(result.join("")).toBe(zh);
    expect(result.some((p) => p.includes("范围"))).toBe(true);
    expect(result.some((p) => p.endsWith("范"))).toBe(false);
  });
});

describe("ensureEnoughFineCues", () => {
  const cue = (start: string, end: string, text: string) => ({ start, end, text: [text] });

  it("returns cues unchanged when there are already enough", () => {
    const cues = [cue("00:00:00,000", "00:00:02,000", "one two three")];
    expect(ensureEnoughFineCues(cues, 1)).toEqual(cues);
  });

  it("splits the longest-duration cue to create an extra display slot", () => {
    const cues = [cue("00:00:00,000", "00:00:04,000", "one two three four five six")];
    const result = ensureEnoughFineCues(cues, 2);

    expect(result).toHaveLength(2);
    // Timing is contiguous and spans the original range.
    expect(result[0]!.start).toBe("00:00:00,000");
    expect(result[1]!.end).toBe("00:00:04,000");
    expect(result[0]!.end).toBe(result[1]!.start);
    // Text is preserved, just divided between the two halves.
    expect(`${result[0]!.text.join(" ")} ${result[1]!.text.join(" ")}`).toBe(
      "one two three four five six",
    );
  });

  it("stops and returns as-is when the only cue is a single word (unsplittable)", () => {
    const cues = [cue("00:00:00,000", "00:00:02,000", "hello")];
    expect(ensureEnoughFineCues(cues, 3)).toEqual(cues);
  });

  it("refuses a split that would leave a half shorter than the minimum duration", () => {
    // 1.2s total — splitting in half would give two ~0.6s halves, under the 1s floor.
    const cues = [cue("00:00:00,000", "00:00:01,200", "one two three four")];
    expect(ensureEnoughFineCues(cues, 2)).toEqual(cues);
  });

  it("picks the longest-duration cue among several to split first", () => {
    const cues = [
      cue("00:00:00,000", "00:00:01,200", "short cue words"),
      cue("00:00:01,200", "00:00:07,200", "this is the much longer cue with many words in it"),
    ];
    const result = ensureEnoughFineCues(cues, 3);

    expect(result).toHaveLength(3);
    // The short cue (index 0 pre-split) survives untouched; the long one split.
    expect(result[0]).toEqual(cues[0]);
  });

  it("uses real word timing for the split point instead of the proportional-length guess, when available", () => {
    // "hi" is textually tiny next to "loooong", so the proportional guess
    // would place the split near the very start of the 10s cue. Real timing
    // says the opposite: "hi" was actually spoken slowly, taking 8 of the 10
    // seconds, and "loooong" was rushed through in the last 2.
    const cues = [cue("00:00:00,000", "00:00:10,000", "hi loooong")];
    const wordTimings: WordTiming[] = [
      { word: "hi", start: 0, end: 8 },
      { word: "loooong", start: 8, end: 10 },
    ];

    const result = ensureEnoughFineCues(cues, 2, wordTimings);

    expect(result).toHaveLength(2);
    expect(result[0]!.end).toBe("00:00:08,000");
    expect(result[1]!.start).toBe("00:00:08,000");
  });

  it("falls back to the proportional guess when word timing is provided but doesn't match the cue's words", () => {
    const cues = [cue("00:00:00,000", "00:00:10,000", "hi loooong")];
    const wordTimings: WordTiming[] = [
      { word: "completely", start: 0, end: 5 },
      { word: "unrelated", start: 5, end: 10 },
    ];

    const result = ensureEnoughFineCues(cues, 2, wordTimings);

    expect(result).toHaveLength(2);
    // Proportional guess: len("hi")=2, len("loooong")=7, split near 2/9 of 10s.
    expect(result[0]!.end).not.toBe("00:00:08,000");
  });
});
