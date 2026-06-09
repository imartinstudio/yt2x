import { z } from "zod";

/** 单条帖子 LLM 输出 */
export const ClipPostSchema = z.object({
  first_line: z.string().describe("首句（X 信息流可见的前 150 字），必须是场景钩子，不是功能介绍"),
  body: z.string().describe("2-4 句正文，包含具体细节或关键信息"),
  teaser_next: z.string().describe("末尾钩子，预告下一篇，如「明天发：xx」"),
  hashtags: z.string().describe("标签行，如 #Codex #AI编程效率"),
});

export type ClipPost = z.infer<typeof ClipPostSchema>;

/** 多条帖子 LLM 输出 */
export const ClipPostListSchema = z.object({
  posts: z.array(ClipPostSchema).min(1).max(10),
});

export type ClipPostList = z.infer<typeof ClipPostListSchema>;

/** post-generator 输入 */
export type GeneratePostsInput = {
  articleTitle: string;
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
