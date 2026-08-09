import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditSubtitleArtifacts,
  isSubtitleAuditReadyForDelivery,
  type SubtitleAuditInput,
} from "./audit-subtitles.js";
import { createTechnicalTermGuard } from "@yt2x/core";

const srt = (
  cues: readonly { start?: string; end?: string; lines: readonly string[] }[],
): string =>
  `${cues.map((cue, index) => [
    index + 1,
    `${cue.start ?? `00:00:0${index},000`} --> ${cue.end ?? `00:00:0${index + 1},000`}`,
    ...cue.lines,
  ].join("\n")).join("\n\n")}\n`;

const sourceSrt = srt([
  { start: "00:00:00,000", end: "00:00:02,000", lines: ["Hello world."] },
  { start: "00:00:02,000", end: "00:00:04,000", lines: ["Ship Codex safely."] },
]);
const enSrt = sourceSrt;
const zhSrt = srt([
  { start: "00:00:00,000", end: "00:00:02,000", lines: ["你好，世界。"] },
  { start: "00:00:02,000", end: "00:00:04,000", lines: ["安全交付 Codex。"] },
]);
const bilingualSrt = srt([
  {
    start: "00:00:00,000",
    end: "00:00:02,000",
    lines: ["你好，世界。", "Hello world."],
  },
  {
    start: "00:00:02,000",
    end: "00:00:04,000",
    lines: ["安全交付 Codex。", "Ship Codex safely."],
  },
]);
const sourceSha256 = createHash("sha256").update(sourceSrt).digest("hex");

const validInput = (overrides: Partial<SubtitleAuditInput> = {}): SubtitleAuditInput => ({
  sourceSrt,
  enSrt,
  zhSrt,
  bilingualSrt,
  manifest: { sourceSha256 },
  ...overrides,
});

describe("auditSubtitleArtifacts", () => {
  it("reports a glossary violation from the full technical term profile", () => {
    const guard = createTechnicalTermGuard({ sourceText: "Knowledge Graph" });
    const result = auditSubtitleArtifacts(validInput({
      sourceSrt: srt([{ lines: ["Knowledge Graph"] }]),
      enSrt: srt([{ lines: ["Knowledge Graph"] }]),
      zhSrt: srt([{ lines: ["知识图谱"] }]),
      bilingualSrt: srt([{ lines: ["知识图谱", "Knowledge Graph"] }]),
      manifest: { sourceSha256: createHash("sha256").update(srt([{ lines: ["Knowledge Graph"] }])).digest("hex") },
      technicalTermGuard: guard,
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "glossary-violation",
      severity: "content",
    }));
    expect(result.verdict).toBe("fail");
  });

  it("does not turn a natural Chinese 图 into Graph when Graph Engineering is also present", () => {
    const source = srt([
      { lines: ["Graph Engineering helps."], start: "00:00:00,000", end: "00:00:02,000" },
      { lines: ["When is it worth using a graph?"], start: "00:00:02,000", end: "00:00:04,000" },
    ]);
    const guard = createTechnicalTermGuard({ sourceText: "Graph Engineering helps. When is it worth using a graph?" });
    const result = auditSubtitleArtifacts({
      sourceSrt: source,
      enSrt: source,
      zhSrt: srt([
        { lines: ["Graph Engineering 很有帮助。"], start: "00:00:00,000", end: "00:00:02,000" },
        { lines: ["什么时候值得用图？"], start: "00:00:02,000", end: "00:00:04,000" },
      ]),
      bilingualSrt: srt([
        { lines: ["Graph Engineering 很有帮助。", "Graph Engineering helps."], start: "00:00:00,000", end: "00:00:02,000" },
        { lines: ["什么时候值得用图？", "When is it worth using a graph?"], start: "00:00:02,000", end: "00:00:04,000" },
      ]),
      manifest: { sourceSha256: createHash("sha256").update(source).digest("hex") },
      technicalTermGuard: guard,
    });

    expect(result.issues.filter((issue) => issue.code === "glossary-violation")).toEqual([]);
  });

  it("passes artifacts that satisfy every available invariant", () => {
    expect(auditSubtitleArtifacts(validInput())).toEqual({
      verdict: "pass",
      issues: [],
    });
  });

  it("reports source-sha when the manifest does not match the source artifact", () => {
    const result = auditSubtitleArtifacts(validInput({
      manifest: { sourceSha256: "stale" },
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "source-sha",
      severity: "content",
    }));
    expect(result.verdict).toBe("fail");
  });

  it("reports coverage-loss when article English drops a source word", () => {
    const result = auditSubtitleArtifacts(validInput({
      enSrt: srt([
        { lines: ["Hello."] },
        { lines: ["Ship Codex safely."] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "coverage-loss",
      severity: "content",
    }));
  });

  it("reports empty-text when an aligned Chinese cue is blank", () => {
    const result = auditSubtitleArtifacts(validInput({
      zhSrt: srt([
        { lines: ["你好，世界。"] },
        { lines: [" "] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "empty-text",
      severity: "content",
      cueIndex: 2,
    }));
  });

  it("reports empty-text when an aligned subtitle artifact contains no cues", () => {
    const result = auditSubtitleArtifacts(validInput({ zhSrt: "" }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "empty-text",
      severity: "content",
    }));
  });

  it("reports timing-invalid when a cue has a non-positive duration", () => {
    const result = auditSubtitleArtifacts(validInput({
      enSrt: srt([
        { start: "00:00:01,000", end: "00:00:01,000", lines: ["Hello world."] },
        { lines: ["Ship Codex safely."] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "timing-invalid",
      severity: "content",
      cueIndex: 1,
    }));
  });

  it("reports timing-overlap when adjacent cues overlap in one artifact", () => {
    const result = auditSubtitleArtifacts(validInput({
      zhSrt: srt([
        { end: "00:00:01,500", lines: ["你好，世界。"] },
        { start: "00:00:01,000", end: "00:00:02,000", lines: ["安全交付 Codex。"] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "timing-overlap",
      severity: "content",
      cueIndex: 2,
    }));
  });

  it("reports bilingual-timing when aligned artifacts use different windows", () => {
    const result = auditSubtitleArtifacts(validInput({
      bilingualSrt: srt([
        { end: "00:00:00,900", lines: ["你好，世界。", "Hello world."] },
        { lines: ["安全交付 Codex。", "Ship Codex safely."] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "bilingual-timing",
      severity: "content",
      cueIndex: 1,
    }));
  });

  it("does not flag identical Chinese repeated across cues with different English", () => {
    // A Chinese caption legitimately spans several shorter English sub-cues
    // (Chinese is more compact than English) — this must never be treated
    // as a content bug. See semantic-bilingual-subtitles.ts's long-sentence
    // split, which produces exactly this shape by design.
    const result = auditSubtitleArtifacts(validInput({
      enSrt: srt([
        { lines: ["However,"] },
        { lines: ["I sometimes hear from people."] },
      ]),
      zhSrt: srt([
        { lines: ["不过，我有时听别人说，"] },
        { lines: ["不过，我有时听别人说，"] },
      ]),
      bilingualSrt: srt([
        { lines: ["不过，我有时听别人说，", "However,"] },
        { lines: ["不过，我有时听别人说，", "I sometimes hear from people."] },
      ]),
    }));

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "adjacent-duplicate" }),
    );
  });

  it("reports glossary-violation when a protected English term is translated away", () => {
    const result = auditSubtitleArtifacts(validInput({
      zhSrt: srt([
        { lines: ["你好，世界。"] },
        { lines: ["安全交付代码助手。"] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "glossary-violation",
      severity: "content",
      cueIndex: 2,
    }));
  });

  describe("glossary-violation with utteranceBoundariesMs (utterance-level grouping)", () => {
    // 一个话语单元 [0, 4000)ms 被细分成两条显示单元；"PRD" 落在英文第一条，却落在
    // 中文第二条——中英文切分边界不同（中文按视觉宽度切、英文按词数占比切），是
    // 真实全片跑出来的假阳性形状，不是伪造样本。
    const utteranceSourceSrt = srt([
      { start: "00:00:00,000", end: "00:00:02,000", lines: ["Ship the PRD"] },
      { start: "00:00:02,000", end: "00:00:04,000", lines: ["to the team."] },
    ]);
    const utteranceEnSrt = utteranceSourceSrt;
    const utteranceSha256 = createHash("sha256").update(utteranceSourceSrt).digest("hex");

    it("does not flag a protected term that lands in a different cue of the same utterance", () => {
      const zh = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["PRD。"] },
      ]);
      const bilingual = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的", "Ship the PRD"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["PRD。", "to the team."] },
      ]);

      const result = auditSubtitleArtifacts({
        sourceSrt: utteranceSourceSrt,
        enSrt: utteranceEnSrt,
        zhSrt: zh,
        bilingualSrt: bilingual,
        manifest: { sourceSha256: utteranceSha256 },
        utteranceBoundariesMs: [4000],
      });

      expect(result.issues).not.toContainEqual(
        expect.objectContaining({ code: "glossary-violation" }),
      );
    });

    it("still flags a protected term missing from every cue in the utterance group", () => {
      const zh = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["产品需求文档。"] },
      ]);
      const bilingual = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的", "Ship the PRD"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["产品需求文档。", "to the team."] },
      ]);

      const result = auditSubtitleArtifacts({
        sourceSrt: utteranceSourceSrt,
        enSrt: utteranceEnSrt,
        zhSrt: zh,
        bilingualSrt: bilingual,
        manifest: { sourceSha256: utteranceSha256 },
        utteranceBoundariesMs: [4000],
      });

      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "glossary-violation", severity: "content" }),
      );
    });

    it("falls back to per-cue comparison when utteranceBoundariesMs is not provided", () => {
      // 与第一个用例完全同样的输入，但不传话语单元边界——必须复现旧的逐条比对行为，
      // 确认没有传边界的调用方（纯字幕交付路径）不受这次改动影响。
      const zh = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["PRD。"] },
      ]);
      const bilingual = srt([
        { start: "00:00:00,000", end: "00:00:02,000", lines: ["安全交付给团队的", "Ship the PRD"] },
        { start: "00:00:02,000", end: "00:00:04,000", lines: ["PRD。", "to the team."] },
      ]);

      const result = auditSubtitleArtifacts({
        sourceSrt: utteranceSourceSrt,
        enSrt: utteranceEnSrt,
        zhSrt: zh,
        bilingualSrt: bilingual,
        manifest: { sourceSha256: utteranceSha256 },
      });

      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "glossary-violation", cueIndex: 1 }),
      );
    });
  });

  it("reports hard-layout when a measured cue exceeds the hard threshold", () => {
    const result = auditSubtitleArtifacts(validInput({
      measurements: [{ cueIndex: 1, severity: "hard", lineCount: 2 }],
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "hard-layout",
      severity: "presentation",
      cueIndex: 1,
    }));
    expect(result.verdict).toBe("warn");
  });

  it("accepts a Chinese cue that spans several display cues", () => {
    // issue #109：中文单语产物是显示时间轴的「粗化」——一句中文覆盖它原本被
    // 复制到的那几条显示单元。这是期望形态，不该报 bilingual-timing。
    const mergedZh = srt([
      { start: "00:00:00,000", end: "00:00:04,000", lines: ["你好，世界。"] },
    ]);

    const result = auditSubtitleArtifacts(validInput({ zhSrt: mergedZh }));

    expect(result.issues.filter((issue) => issue.code === "bilingual-timing")).toEqual([]);
  });

  it("rejects a Chinese cue whose span does not land on display cue boundaries", () => {
    // 粗化必须落在显示单元的边界上。切在中间意味着中文轨与显示轨已经错开，
    // 那正是这道校验要拦的——不能因为放宽了 cue 数就把时间漂移一起放过去。
    const driftedZh = srt([
      { start: "00:00:00,000", end: "00:00:03,000", lines: ["你好，世界。"] },
      { start: "00:00:03,000", end: "00:00:04,000", lines: ["安全交付 Codex。"] },
    ]);

    const result = auditSubtitleArtifacts(validInput({ zhSrt: driftedZh }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "bilingual-timing",
      severity: "content",
    }));
  });

  it("rejects a Chinese track that stops short of the last display cue", () => {
    // 丢内容也要拦：中文轨只覆盖了前半段，后面的显示单元没有对应的中文。
    const truncatedZh = srt([
      { start: "00:00:00,000", end: "00:00:02,000", lines: ["你好，世界。"] },
    ]);

    const result = auditSubtitleArtifacts(validInput({ zhSrt: truncatedZh }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "bilingual-timing",
      severity: "content",
      message: expect.stringContaining("covers 1 of 2 display cues") as unknown as string,
    }));
  });

  it("reports width-budget from text width alone, with or without measurements", () => {
    // The run that shipped a 44-cell Chinese line across five cues measured
    // clean — one cps finding, no hard-layout, no line-count — because the
    // line did fit the frame. It was simply far too much text for one
    // caption, and no check looked at width in the writer's own units.
    // Width is a property of what gets rendered, so it is read off the
    // bilingual artifact's Chinese line — the mono artifact may cover several
    // display cues with one entry (issue #109) and cannot answer "how wide is
    // this caption".
    const wideZhText = `安全交付 Codex${"测".repeat(25)}`;
    const wideZh = srt([
      { start: "00:00:00,000", end: "00:00:02,000", lines: ["你好，世界。"] },
      { start: "00:00:02,000", end: "00:00:04,000", lines: [wideZhText] },
    ]);
    const wideBilingual = srt([
      { start: "00:00:00,000", end: "00:00:02,000", lines: ["你好，世界。", "Hello world."] },
      { start: "00:00:02,000", end: "00:00:04,000", lines: [wideZhText, "Ship Codex safely."] },
    ]);

    for (const measurements of [
      undefined,
      [{ cueIndex: 1, severity: "fit" as const, lineCount: 1 },
        { cueIndex: 2, severity: "fit" as const, lineCount: 1 }],
    ]) {
      const result = auditSubtitleArtifacts(validInput(
        measurements === undefined
          ? { zhSrt: wideZh, bilingualSrt: wideBilingual }
          : { zhSrt: wideZh, bilingualSrt: wideBilingual, measurements },
      ));

      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "width-budget",
        severity: "presentation",
        cueIndex: 2,
      }));
      // The cue that fits the budget stays clean.
      expect(result.issues.filter((issue) => issue.code === "width-budget")).toHaveLength(1);
    }
  });

  it("never blocks a burn on width-budget, which the font measurement may well say fits", () => {
    const report = {
      verdict: "warn" as const,
      issues: [{
        code: "width-budget" as const,
        severity: "presentation" as const,
        message: "over budget",
      }],
    };

    for (const mode of ["srt", "ass", "burned", "all"] as const) {
      expect(isSubtitleAuditReadyForDelivery(report, mode)).toBe(true);
    }
  });

  it("reports line-count when rendering needs more than two lines", () => {
    const result = auditSubtitleArtifacts(validInput({
      measurements: [{ cueIndex: 2, severity: "aim", lineCount: 3 }],
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "line-count",
      severity: "presentation",
      cueIndex: 2,
    }));
  });

  it("reports cps when Chinese reading speed exceeds nine characters per second", () => {
    const fastZh = srt([
      { lines: ["一二三四五六七八九十"] },
      { lines: ["安全交付 Codex。"] },
    ]);
    const result = auditSubtitleArtifacts(validInput({
      zhSrt: fastZh,
      bilingualSrt: srt([
        { lines: ["一二三四五六七八九十", "Hello world."] },
        { lines: ["安全交付 Codex。", "Ship Codex safely."] },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "cps",
      severity: "presentation",
      cueIndex: 1,
    }));
  });

  it("does not report cps for a cue whose length comes from a deliberately kept English term", () => {
    // Regression: cps counted every Latin letter as one full CJK cell, so a
    // cue carrying a protected glossary term ("Air Coding Cohort" — 15 raw
    // characters, 7.5 CJK cells) scored 9.69 "cps" and blocked delivery,
    // even though a viewer reads it comfortably. The pipeline is *required*
    // to keep such terms untranslated, and `compactDenseBlocks` is required
    // not to drop them — so this finding was unfixable by design and the
    // quality gate deadlocked. Reading speed must be measured in the same
    // visual-width units the rest of the pipeline budgets against.
    const termSource = srt([{
      start: "00:00:00,000",
      end: "00:00:02,374",
      lines: ["You will love my Air Coding Cohort"],
    }]);
    const result = auditSubtitleArtifacts({
      sourceSrt: termSource,
      enSrt: termSource,
      zhSrt: srt([{
        start: "00:00:00,000",
        end: "00:00:02,374",
        lines: ["那你定会爱上我的Air Coding Cohort"],
      }]),
      bilingualSrt: srt([{
        start: "00:00:00,000",
        end: "00:00:02,374",
        lines: ["那你定会爱上我的Air Coding Cohort", "You will love my Air Coding Cohort"],
      }]),
      manifest: { sourceSha256: createHash("sha256").update(termSource).digest("hex") },
    });

    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: "cps" }));
    expect(result.verdict).toBe("pass");
  });

  it("reports flash when a delivered cue is shorter than one second", () => {
    const shortEn = srt([
      { end: "00:00:00,800", lines: ["Hello world."] },
      { start: "00:00:00,800", end: "00:00:02,000", lines: ["Ship Codex safely."] },
    ]);
    const shortZh = srt([
      { end: "00:00:00,800", lines: ["你好。"] },
      { start: "00:00:00,800", end: "00:00:02,000", lines: ["交付 Codex。"] },
    ]);
    const result = auditSubtitleArtifacts(validInput({
      enSrt: shortEn,
      zhSrt: shortZh,
      bilingualSrt: srt([
        { end: "00:00:00,800", lines: ["你好。", "Hello world."] },
        {
          start: "00:00:00,800",
          end: "00:00:02,000",
          lines: ["交付 Codex。", "Ship Codex safely."],
        },
      ]),
    }));

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "flash",
      severity: "presentation",
      cueIndex: 1,
    }));
  });

  it("measures cps and flash over the combined duration when identical Chinese repeats across consecutive cues", () => {
    // Regression: a real run flagged cps/flash on a cue whose text was
    // identical to its neighbor and only individually looked too fast/short.
    // 8 Chinese characters shown for 0.4s alone would read at 20 cps and
    // count as a flash — but the SAME unchanged text is actually on screen
    // for a combined 2.0s (4 cps, comfortably over 1s), because it repeats
    // onto the next cue rather than changing.
    const repeatedZh = srt([
      { end: "00:00:00,400", lines: ["一二三四五六七八"] },
      { start: "00:00:00,400", end: "00:00:02,000", lines: ["一二三四五六七八"] },
    ]);
    const result = auditSubtitleArtifacts(validInput({
      zhSrt: repeatedZh,
      enSrt: srt([
        { end: "00:00:00,400", lines: ["However,"] },
        { start: "00:00:00,400", end: "00:00:02,000", lines: ["I sometimes hear from people."] },
      ]),
      bilingualSrt: srt([
        { end: "00:00:00,400", lines: ["一二三四五六七八", "However,"] },
        {
          start: "00:00:00,400",
          end: "00:00:02,000",
          lines: ["一二三四五六七八", "I sometimes hear from people."],
        },
      ]),
    }));

    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: "cps" }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: "flash" }));
  });

  it("reports unsafe-layout when a hard cue has no safe source cue boundary", () => {
    const oneSource = srt([
      {
        start: "00:00:00,000",
        end: "00:00:03,000",
        lines: ["Hello world. Ship Codex safely."],
      },
    ]);
    const result = auditSubtitleArtifacts({
      sourceSrt: oneSource,
      enSrt: oneSource,
      zhSrt: srt([{
        start: "00:00:00,000",
        end: "00:00:03,000",
        lines: ["你好，安全交付 Codex。"],
      }]),
      bilingualSrt: srt([{
        start: "00:00:00,000",
        end: "00:00:03,000",
        lines: ["你好，安全交付 Codex。", "Hello world. Ship Codex safely."],
      }]),
      manifest: {
        sourceSha256: createHash("sha256").update(oneSource).digest("hex"),
      },
      measurements: [{ cueIndex: 1, severity: "hard", lineCount: 2 }],
    });

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "unsafe-layout",
      severity: "presentation",
      cueIndex: 1,
    }));
  });
});

describe("isSubtitleAuditReadyForDelivery", () => {
  it("blocks content in every mode", () => {
    const contentReport = {
      verdict: "fail" as const,
      issues: [{ code: "empty-text" as const, severity: "content" as const, message: "empty" }],
    };

    for (const mode of ["srt", "ass", "burned", "all"] as const) {
      expect(isSubtitleAuditReadyForDelivery(contentReport, mode)).toBe(false);
    }
  });

  it("blocks layout presentation findings only for burned delivery", () => {
    for (const code of ["hard-layout", "unsafe-layout", "line-count"] as const) {
      const report = {
        verdict: "warn" as const,
        issues: [{ code, severity: "presentation" as const, message: "does not fit" }],
      };
      expect(isSubtitleAuditReadyForDelivery(report, "srt")).toBe(true);
      expect(isSubtitleAuditReadyForDelivery(report, "ass")).toBe(true);
      expect(isSubtitleAuditReadyForDelivery(report, "burned")).toBe(false);
      expect(isSubtitleAuditReadyForDelivery(report, "all")).toBe(false);
    }
  });

  it("never blocks reading-speed debt, which describes correct frames that merely read fast", () => {
    // cps/flash say nothing is *wrong* with the rendered frame — the burned
    // video is faithful, just brisk. Blocking on them made a single
    // sub-1%-of-cues nit a hard pipeline failure that also marked the
    // manifest failed, invalidating the cache and forcing a full,
    // non-deterministic re-translation on every retry.
    for (const code of ["cps", "flash"] as const) {
      const report = {
        verdict: "warn" as const,
        issues: [{ code, severity: "presentation" as const, message: "fast" }],
      };
      for (const mode of ["srt", "ass", "burned", "all"] as const) {
        expect(isSubtitleAuditReadyForDelivery(report, mode)).toBe(true);
      }
    }
  });
});
