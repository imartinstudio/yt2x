import { describe, it, expect } from "vitest";
import { generateDecompositionReport, generateProfessionalReview } from "./report.js";
import type { DeconstructManifest } from "@yt2x/core";

const mockManifest: DeconstructManifest = {
  v: 1,
  source: { videoId: "test123", articlePath: "../article.md", durationSec: 600 },
  generatedAt: "2026-06-09T12:00:00.000Z",
  candidateCount: 3,
  total: 2,
  clips: [
    {
      id: "clip-1",
      slug: "hot-take-one",
      title: "爆论一",
      type: "hot-take",
      angle: "contrarian",
      risk: "low",
      selected: true,
      timecodes: { start: "00:01:00", end: "00:02:00", startSec: 60, endSec: 120, durationSec: 60 },
      video: "clip-1-hot-take-one.mp4",
      scores: { counter_intuitiveness: 5, shareability: 4, practical_value: 3, visual_appeal: 4, composite: 4.0 },
      text: "🧵 Codex 深度拆解 1/2\n\n首句钩子\n\n正文内容\n\n🎬 视频 clip-1.mp4（60s）\n\n📖 完整文章\n\n📌 明天发 2/2\n#Codex #AI编程效率",
      articleSection: "测试章节",
      nextTeaser: "📌 明天发 2/2",
      charCount: 120,
      firstLineChars: 20,
    },
    {
      id: "clip-2",
      slug: "practical-tip",
      title: "实用技巧二",
      type: "insight",
      angle: "practical",
      risk: "low",
      selected: true,
      timecodes: { start: "00:02:00", end: "00:03:00", startSec: 120, endSec: 180, durationSec: 60 },
      video: "clip-2-practical-tip.mp4",
      scores: { counter_intuitiveness: 2, shareability: 3, practical_value: 5, visual_appeal: 2, composite: 3.0 },
      text: "🧵 Codex 深度拆解 2/2\n\n第二条首句\n\n第二条正文\n\n🎬 视频 clip-2.mp4（60s）\n\n📖 完整文章\n\n完整长文 👇\n🔗 https://youtube.com/watch?v=test123\n#Codex #AI编程效率",
      articleSection: "测试章节二",
      nextTeaser: "完整长文 👇\n🔗 https://youtube.com/watch?v=test123",
      charCount: 130,
      firstLineChars: 18,
    },
    {
      id: "clip-3",
      slug: "unselected-one",
      title: "未选中",
      type: "insight",
      angle: "tutorial",
      risk: "low",
      selected: false,
      timecodes: { start: "00:03:00", end: "00:04:00", startSec: 180, endSec: 240, durationSec: 60 },
      video: "candidate-3-unselected.mp4",
      scores: { counter_intuitiveness: 1, shareability: 1, practical_value: 2, visual_appeal: 1, composite: 1.3 },
      articleSection: "未选中章节",
    },
  ],
};

describe("generateDecompositionReport", () => {
  it("includes source video info in header", () => {
    const report = generateDecompositionReport(mockManifest, "测试文章");
    expect(report).toContain("test123");
    expect(report).toContain("测试文章");
    expect(report).toContain("10min");
  });

  it("shows selected clip table when clips are selected", () => {
    const report = generateDecompositionReport(mockManifest, "测试");
    expect(report).toContain("已选中章节");
    expect(report).toContain("爆论一");
    expect(report).toContain("实用技巧二");
  });

  it("does not include unselected clips in selected table", () => {
    const report = generateDecompositionReport(mockManifest, "测试");
    // The selected table should not reference the unselected clip
    const selectedSection = report.split("完整章节清单")[0]!;
    expect(selectedSection).not.toContain("未选中");
  });

  it("includes all clips in the full chapter list", () => {
    const report = generateDecompositionReport(mockManifest, "测试");
    expect(report).toContain("未选中");
  });

  it("includes scoring matrix", () => {
    const report = generateDecompositionReport(mockManifest, "测试");
    expect(report).toContain("反直觉");
    expect(report).toContain("传播力");
    expect(report).toContain("实操收益");
    expect(report).toContain("表现力");
  });
});

describe("generateProfessionalReview", () => {
  it("shows note when no posts are generated", () => {
    const noTextManifest = { ...mockManifest, clips: mockManifest.clips.map(c => ({ ...c, text: undefined, selected: false })) };
    const report = generateProfessionalReview(noTextManifest, "测试");
    expect(report).toContain("尚未生成帖子文案");
  });

  it("diagnoses each selected clip with text", () => {
    const report = generateProfessionalReview(mockManifest, "测试");
    expect(report).toContain("爆论一");
    expect(report).toContain("实用技巧二");
    expect(report).toContain("首句");
    expect(report).toContain("正文长度");
  });

  it("checks for first-line quality issues", () => {
    const report = generateProfessionalReview(mockManifest, "测试");
    // Should have a STYLE assessment
    expect(report).toContain("STYLE");
  });

  it("includes posting schedule recommendations", () => {
    const report = generateProfessionalReview(mockManifest, "测试");
    expect(report).toContain("发布节奏");
    expect(report).toContain("Day 1");
    expect(report).toContain("Day 2");
  });

  it("includes file verification section", () => {
    const report = generateProfessionalReview(mockManifest, "测试");
    expect(report).toContain("文件核验");
    expect(report).toContain("clip-1-hot-take-one.mp4");
  });
});
