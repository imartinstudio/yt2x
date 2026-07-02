import { describe, expect, it } from "vitest";
import type { SectionCandidate } from "@yt2x/core";
import { selectTopUniqueArticleSections } from "./selector.js";

const makeCandidate = (
  id: string,
  articleSection: string,
  composite: number,
): SectionCandidate => ({
  id,
  title: id,
  summary: "",
  article_section: articleSection,
  angle: "tutorial",
  risk: "low",
  timecodes: {
    start: "00:00:00,000",
    end: "00:01:00,000",
    startSec: 0,
    endSec: 60,
    durationSec: 60,
  },
  scores: {
    counter_intuitiveness: 1,
    shareability: 1,
    practical_value: 1,
    visual_appeal: 1,
    composite,
  },
  key_quote: "",
  video_script: "",
});

describe("selectTopUniqueArticleSections", () => {
  it("keeps only the highest-scored clip per article section", () => {
    const sections = [
      makeCandidate("section-1-part1", "OAuth 授权故障排除", 4.1),
      makeCandidate("section-1-part2", "OAuth 授权故障排除", 4.8),
      makeCandidate("section-2", "X MCP 原生入口", 3.9),
    ];

    const selected = selectTopUniqueArticleSections(sections, 10);

    expect(selected.map((s) => s.section.id)).toEqual([
      "section-1-part2",
      "section-2",
    ]);
    expect(selected.map((s) => s.originalIndex)).toEqual([1, 2]);
  });

  it("applies the requested limit after article-section dedupe", () => {
    const sections = [
      makeCandidate("section-1-part1", "重复主题", 4.2),
      makeCandidate("section-1-part2", "重复主题", 4.9),
      makeCandidate("section-2", "独立主题", 4.5),
    ];

    const selected = selectTopUniqueArticleSections(sections, 1);

    expect(selected.map((s) => s.section.id)).toEqual(["section-1-part2"]);
  });
});
