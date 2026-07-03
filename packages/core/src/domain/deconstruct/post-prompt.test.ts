import { describe, expect, it } from "vitest";
import { CLIP_POST_SYSTEM_PROMPT, ClipPostSchema } from "./index.js";

describe("clip post prompt", () => {
  it("requires an AnatoliKopadze-style agents leverage template", () => {
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("@AnatoliKopadze");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("开头引述");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("loops 比模型更关键");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("视频承接句");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("这是公开文案的一部分");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("不要写「建议附上」");
    expect(CLIP_POST_SYSTEM_PROMPT).not.toContain("视频建议");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("不要生成 call_to_action");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("只在最后一个实际选中的切片文案末尾追加一次固定 CTA");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("没有真实引用时，opening_quote 改用观点式开头");
    expect(CLIP_POST_SYSTEM_PROMPT).not.toContain("Quote needed");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain(
      "先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。",
    );
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("写成中文 X 贴文");
    expect(CLIP_POST_SYSTEM_PROMPT).toContain("标题必须是中文纯文本，不要 emoji，不要「｜N/N」");
  });

  it("uses fields for quote, leverage context, video suggestion, and CTA", () => {
    const parsed = ClipPostSchema.safeParse({
      title: "Loops are the edge",
      opening_quote: "「Agent 真正有用，是因为它能不断改进自己的 loop。」——输入素材中的 CTO",
      core_description: "护城河不是模型本身，而是围绕它的 loop：评估、重试、上下文、工具反馈和部署节奏。",
      video_suggestion: "视频里可以看到，agent 反复重试工作流，直到 PR 变绿。",
    });

    expect(parsed.success).toBe(true);
  });
});
