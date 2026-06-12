import { describe, it, expect } from "vitest";
import {
  filterValidSections,
  toSlug,
  candidateVideoFilename,
  timecodeToSeconds,
  secondsToTimecode,
  parseSrt,
  validateClipEndings,
} from "./generator.js";
import { chooseClipTitleEmoji, deriveSeriesName, formatClipPostSeriesTitle } from "./post-generator.js";

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
  it("formats Claude titles with a semantic emoji and pipe progress", () => {
    const articleTitle = "Claude Code 从 0 到 1 全攻略：90% 的用户只用了 10% 的功能";
    expect(formatClipPostSeriesTitle({
      articleTitle,
      seriesName: deriveSeriesName(articleTitle),
      index: 1,
      total: 5,
    })).toBe("🧠 Claude Code 从 0 到 1 全攻略 | 1/5");
  });

  it("uses a Codex-specific emoji when Codex is the only named tool", () => {
    expect(formatClipPostSeriesTitle({
      articleTitle: "Codex 全攻略：从 Fork 到 Automation",
      seriesName: "Codex 全攻略",
      index: 2,
      total: 3,
    })).toBe("🤖 Codex 全攻略 | 2/3");
  });

  it("uses a neutral emoji when multiple named tools are present", () => {
    expect(chooseClipTitleEmoji("Claude Code 和 Codex 实战对比")).toBe("🧭");
  });

  it("falls back to a generic emoji without named tools", () => {
    expect(formatClipPostSeriesTitle({
      articleTitle: "AI 工作流从入门到落地",
      seriesName: "AI 工作流",
      index: 1,
      total: 2,
    })).toBe("🧩 AI 工作流 | 1/2");
  });
});
