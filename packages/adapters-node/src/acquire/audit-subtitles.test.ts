import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditSubtitleArtifacts,
  isSubtitleAuditReadyForDelivery,
  type SubtitleAuditInput,
} from "./audit-subtitles.js";

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
