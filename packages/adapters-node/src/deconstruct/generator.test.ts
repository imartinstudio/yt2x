import { describe, it, expect } from "vitest";
import {
  filterValidSections,
  toSlug,
  candidateVideoFilename,
  timecodeToSeconds,
  secondsToTimecode,
  parseSrt,
  validateClipEndings,
  splitOversizedSections,
  parseDeconstructLlmOutput,
} from "./generator.js";
import { deriveSeriesName, formatClipPostSeriesTitle } from "@yt2x/core";

describe("toSlug", () => {
  it("converts Chinese title to slug", () => {
    expect(toSlug("预览区陷阱")).toBe("预览区陷阱");
  });

  it("replaces spaces with hyphens", () => {
    expect(toSlug("hello world")).toBe("hello-world");
  });

  it("trims leading/trailing hyphens", () => {
    expect(toSlug("--hello--")).toBe("hello");
  });

  it("limits length to 60", () => {
    const long = "a".repeat(100);
    expect(toSlug(long).length).toBeLessThanOrEqual(60);
  });
});

describe("candidateVideoFilename", () => {
  it("generates filename from section id and slug", () => {
    const candidate = {
      id: "section-3", title: "测试", summary: "", article_section: "",
      angle: "tutorial" as const, risk: "low" as const,
      timecodes: { start: "00:00", end: "00:10", startSec: 0, endSec: 10, durationSec: 10 },
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
      key_quote: "", video_script: "",
    };
    expect(candidateVideoFilename(candidate)).toBe("candidate-3-测试.mp4");
  });
});

describe("timecodeToSeconds", () => {
  it("converts SRT timecode to seconds", () => {
    expect(timecodeToSeconds("00:01:30,500")).toBeCloseTo(90.5, 1);
  });

  it("handles zero", () => {
    expect(timecodeToSeconds("00:00:00,000")).toBe(0);
  });

  it("returns 0 for invalid input", () => {
    expect(timecodeToSeconds("invalid")).toBe(0);
  });
});

describe("secondsToTimecode", () => {
  it("converts seconds to HH:MM:SS", () => {
    expect(secondsToTimecode(90)).toBe("00:01:30");
  });

  it("handles zero", () => {
    expect(secondsToTimecode(0)).toBe("00:00:00");
  });

  it("handles hours", () => {
    expect(secondsToTimecode(3661)).toBe("01:01:01");
  });
});

describe("filterValidSections", () => {
  it("filters out sections with zero duration", () => {
    const valid = {
      id: "s1", title: "a", summary: "", article_section: "",
      angle: "tutorial" as const, risk: "low" as const,
      timecodes: { start: "00:00", end: "00:10", startSec: 0, endSec: 10, durationSec: 10 },
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
      key_quote: "", video_script: "",
    };
    const invalid = {
      ...valid, id: "s2", timecodes: { ...valid.timecodes, startSec: 0, endSec: 0, durationSec: 0 },
    };
    const result = filterValidSections({ sections: [valid, invalid] });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.id).toBe("s1");
  });
});

describe("parseSrt", () => {
  it("parses SRT content into entries", () => {
    const srt = `1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond line here`;
    const entries = parseSrt(srt);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.index).toBe(1);
    expect(entries[0]!.startSec).toBeCloseTo(1, 1);
    expect(entries[0]!.text).toBe("Hello world");
    expect(entries[1]!.text).toBe("Second line here");
  });

  it("returns empty array for empty input", () => {
    expect(parseSrt("")).toHaveLength(0);
  });
});

describe("validateClipEndings", () => {
  const srt = `1\n00:00:01,000 --> 00:00:05,000\nThis is a complete sentence.\n\n2\n00:00:05,000 --> 00:00:10,000\nAnother complete thought.\n\n3\n00:00:10,000 --> 00:00:15,000\nThis sentence is`;

  it("warns when endSec is mid-entry with gap > 1.5s", () => {
    const sections = [{
      id: "s1", title: "test", summary: "", article_section: "",
      angle: "tutorial" as const, risk: "low" as const,
      timecodes: { start: "00:00:01", end: "00:00:07", startSec: 1, endSec: 7, durationSec: 6 },
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
      key_quote: "", video_script: "",
    }];
    const warnings = validateClipEndings(sections, srt);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe("s1");
    expect(warnings[0]!.warning).toContain("字幕条目");
  });

  it("returns no warnings when endings align with sentence boundaries", () => {
    const sections = [{
      id: "s2", title: "good", summary: "", article_section: "",
      angle: "tutorial" as const, risk: "low" as const,
      timecodes: { start: "00:00:01", end: "00:00:05", startSec: 1, endSec: 5, durationSec: 4 },
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
      key_quote: "", video_script: "",
    }];
    const warnings = validateClipEndings(sections, srt);
    expect(warnings).toHaveLength(0);
  });

  it("warns when SRT entry does not end with sentence-ending punctuation", () => {
    const sections = [{
      id: "s3", title: "cutoff", summary: "", article_section: "",
      angle: "tutorial" as const, risk: "low" as const,
      timecodes: { start: "00:00:10", end: "00:00:15", startSec: 10, endSec: 15, durationSec: 5 },
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
      key_quote: "", video_script: "",
    }];
    const warnings = validateClipEndings(sections, srt);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning).toContain("不以结束标点结尾");
  });
});

describe("filterValidSections with skip_reason", () => {
  const base = {
    id: "s1", title: "a", summary: "", article_section: "",
    angle: "tutorial" as const, risk: "low" as const,
    timecodes: { start: "00:00", end: "00:10", startSec: 0, endSec: 10, durationSec: 10 },
    scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 1, visual_appeal: 1, composite: 1 },
    key_quote: "", video_script: "",
  };

  it("filters out sections with skip_reason set", () => {
    const skipped = { ...base, id: "s2", skip_reason: "无对应字幕" };
    const result = filterValidSections({ sections: [base, skipped] });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.id).toBe("s1");
  });

  it("filters out sections with duration > 180s", () => {
    const oversized = { ...base, id: "s3", timecodes: { ...base.timecodes, endSec: 200, durationSec: 200 } };
    const result = filterValidSections({ sections: [oversized] });
    expect(result.sections).toHaveLength(0);
  });
});

describe("splitOversizedSections", () => {
  const base = {
    id: "section-1", title: "测试", summary: "总结", article_section: "章节",
    angle: "tutorial" as const, risk: "low" as const,
    timecodes: { start: "00:00:00", end: "00:04:00", startSec: 0, endSec: 240, durationSec: 240 },
    scores: { counter_intuitiveness: 3, shareability: 3, practical_value: 3, visual_appeal: 3, composite: 3 },
    key_quote: "quote", video_script: "script",
  };

  const srt = `1\n00:00:00,000 --> 00:00:30,000\nFirst part.\n\n2\n00:00:30,000 --> 00:01:00,000\nMiddle part.\n\n3\n00:01:00,000 --> 00:01:30,000\nSecond middle.\n\n4\n00:01:30,000 --> 00:02:00,000\nThird part.\n\n5\n00:02:00,000 --> 00:02:30,000\nFourth part.\n\n6\n00:02:30,000 --> 00:03:00,000\nFifth part.\n\n7\n00:03:00,000 --> 00:03:30,000\nSixth part.\n\n8\n00:03:30,000 --> 00:04:00,000\nFinal part.`;

  it("splits an oversized section into parts at SRT boundaries", () => {
    const result = splitOversizedSections({ sections: [base] }, srt, 180);
    expect(result.sections.length).toBeGreaterThanOrEqual(2);
    const ids = result.sections.map((s) => s.id);
    expect(ids.every((id) => id.startsWith("section-1-part"))).toBe(true);
    // Each sub-section should be <= 180s
    for (const s of result.sections) {
      expect(s.timecodes.durationSec).toBeLessThanOrEqual(180);
    }
  });

  it("does not split sections under maxDurationSec", () => {
    const short = { ...base, timecodes: { ...base.timecodes, endSec: 100, durationSec: 100 } };
    const result = splitOversizedSections({ sections: [short] }, srt, 180);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.id).toBe("section-1");
  });

  it("preserves sections with skip_reason", () => {
    const skipped = { ...base, skip_reason: "no video" };
    const result = splitOversizedSections({ sections: [skipped] }, srt, 180);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.skip_reason).toBe("no video");
  });

  it("handles equal time split when SRT is sparse", () => {
    const sparseSrt = "1\n00:00:00,000 --> 00:04:00,000\nOnly entry.\n";
    const result = splitOversizedSections({ sections: [base] }, sparseSrt, 180);
    expect(result.sections.length).toBe(2);
    for (const s of result.sections) {
      expect(s.timecodes.durationSec).toBeLessThanOrEqual(180);
    }
  });
});

describe("parseDeconstructLlmOutput null preprocessing", () => {
  it("fills null timecodes with defaults for skipped sections", () => {
    const json = JSON.stringify({
      sections: [{
        id: "section-1", title: "正常", summary: "s", article_section: "a",
        angle: "tutorial", risk: "low",
        timecodes: { start: "00:00", end: "00:10", startSec: 0, endSec: 10, durationSec: 10 },
        scores: { counter_intuitiveness: 3, shareability: 3, practical_value: 3, visual_appeal: 3, composite: 3 },
        key_quote: "q", video_script: "v",
      }, {
        id: "section-2", title: "跳过", summary: "", article_section: "b",
        angle: "discussion", risk: "low",
        timecodes: null, scores: null, key_quote: null, video_script: null,
        skip_reason: "无对应字幕",
      }],
    });
    const result = parseDeconstructLlmOutput(json);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[1]!.timecodes.durationSec).toBe(0);
    expect(result.sections[1]!.scores.composite).toBe(1);
    expect(result.sections[1]!.key_quote).toBe("");
    expect(result.sections[1]!.video_script).toBe("");
  });

  it("fills missing title and summary with defaults", () => {
    const json = JSON.stringify({
      sections: [{
        id: "section-1", title: null, summary: null,
        article_section: null, angle: "discussion", risk: "low",
        timecodes: { start: "00:00", end: "00:10", startSec: 0, endSec: 10, durationSec: 10 },
        scores: { counter_intuitiveness: 3, shareability: 3, practical_value: 3, visual_appeal: 3, composite: 3 },
        key_quote: "q", video_script: "v",
      }],
    });
    const result = parseDeconstructLlmOutput(json);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.title).toBe("未命名");
    expect(result.sections[0]!.summary).toBe("");
    expect(result.sections[0]!.article_section).toBe("");
  });
});

describe("deriveSeriesName", () => {
  it("extracts topic before comma with a short title limit", () => {
    const result = deriveSeriesName("10 个 Claude Code 插件，让你的项目效率翻 10 倍");
    // Split on ， → "10 个 Claude Code 插件" without leaking the subtitle.
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain("Claude Code");
    expect(result).not.toContain("效率翻");
  });

  it("extracts first sentence before Chinese comma", () => {
    const result = deriveSeriesName("浏览器已死，Codex 和 Claude Code 才是知识工作的未来");
    expect(result).toContain("浏览器已死");
    // Short enough that suffix kicks in
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("handles markdown bold", () => {
    expect(deriveSeriesName("**Claude Code** 刚把网站设计行业翻了个底朝天")).toContain("Claude Code");
  });

  it("falls back with suffix for very short titles", () => {
    const result = deriveSeriesName("测试");
    expect(result).toContain("测试");
    expect(result).toContain("深度拆解");
  });
});

describe("clip post series title", () => {
  it("formats with 🎬 emoji and full-width ｜ separator", () => {
    expect(formatClipPostSeriesTitle({
      clipTitle: "我被 2GB 显存的模型上了一课",
      index: 1,
      total: 5,
    })).toBe("🎬 我被 2GB 显存的模型上了一课｜1/5");
  });

  it("handles short titles correctly", () => {
    expect(formatClipPostSeriesTitle({
      clipTitle: "它开始自己干活了",
      index: 2,
      total: 3,
    })).toBe("🎬 它开始自己干活了｜2/3");
  });

  it("handles single post series", () => {
    expect(formatClipPostSeriesTitle({
      clipTitle: "88 秒完成部署",
      index: 1,
      total: 1,
    })).toBe("🎬 88 秒完成部署｜1/1");
  });
});
