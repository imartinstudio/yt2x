import { z } from "zod";

export const CLIP_POST_CALL_TO_ACTION =
  "先看视频，再阅读下方完整/分步指南，学习如何为你的 agents 构建 loops。";

/** 单条帖子 LLM 输出 — AI Agents leverage template */
export const ClipPostSchema = z.object({
  title: z.string().describe("中文标题纯文本，不含 emoji 和序号。突出 agents、loops、杠杆或早期优势"),
  opening_quote: z.string().describe("中文真实直接引语或观点式开头。不得编造名人引语，不得输出占位符"),
  core_description: z.string().describe("中文背景解释 + 具体杠杆例子。必须强调 loops 比模型更关键"),
  video_suggestion: z.string().describe("一句中文视频承接句，作为公开文案的一部分。不要写建议附上/建议配/可以配等内部建议口吻"),
});

export type ClipPost = z.infer<typeof ClipPostSchema>;

/** 多条帖子 LLM 输出 */
export const ClipPostListSchema = z.object({
  posts: z.array(ClipPostSchema).min(1).max(50),
});

export type ClipPostList = z.infer<typeof ClipPostListSchema>;

/** post-generator 输入 */
export type GeneratePostsInput = {
  articleTitle: string;
  /** 短系列名称，用于帖子系列标识行，如「Codex 深度拆解」「Claude Code CMS 实战」 */
  seriesName: string;
  articlePath: string;
  /** 已选中的候选列表（按发帖顺序排列） */
  clips: Array<{
    id: string;
    title: string;
    summary: string;
    angle: string;
    timecodes: { durationSec: number };
    video: string;
  }>;
};
