import { z } from "zod";

/** 单条帖子 LLM 输出 — Martin AI Coding Workflow 四段结构 */
export const ClipPostSchema = z.object({
  title: z.string().describe("10-20字标题，优先意外发现/真实体验/反常识结论/具体结果。禁止功能介绍、教程标题"),
  conflict: z.string().describe("冲突/发现，1-3句。制造认知反差或分享意外发现。写法：发现→过程→感受，非功能→参数→结果"),
  what_happened: z.string().describe("视频里发生了什么，1-3句。第一视角还原视频中的具体画面和动作"),
  conclusion: z.string().describe("一句结论，记忆锚点式收尾。让读者记住一个核心观点"),
});

export type ClipPost = z.infer<typeof ClipPostSchema>;

/** 多条帖子 LLM 输出 */
export const ClipPostListSchema = z.object({
  posts: z.array(ClipPostSchema).min(1).max(30),
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
