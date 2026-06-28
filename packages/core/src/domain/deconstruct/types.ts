import { z } from "zod";

/** 视频片段的时间码（SRT 格式） */
export const TimecodeSchema = z.object({
  start: z.string().describe("SRT start timecode, e.g. 00:01:23,456"),
  end: z.string().describe("SRT end timecode"),
  startSec: z.number().describe("Start time in seconds"),
  endSec: z.number().describe("End time in seconds"),
  durationSec: z.number().describe("Duration in seconds"),
});

export type Timecode = z.infer<typeof TimecodeSchema>;

/** 候选片段的评分维度 */
export const SectionScoresSchema = z.object({
  counter_intuitiveness: z.number().min(1).max(5).describe("颠覆常识的程度（1=常识，5=完全反直觉）"),
  shareability: z.number().min(1).max(5).describe("引发转发/讨论的潜力（1=没人转，5=看到就想发）"),
  practical_value: z.number().min(1).max(5).describe("看完能立刻行动的收益（1=纯知识，5=立刻能操作）"),
  visual_appeal: z.number().min(1).max(5).describe("视频画面的精彩程度（1=口述，5=视觉震撼）"),
  composite: z.number().min(1).max(5).describe("加权综合评分"),
});

export type SectionScores = z.infer<typeof SectionScoresSchema>;

/** 片段类型 */
export const SectionAngle = z.enum([
  "contrarian",
  "practical",
  "warning",
  "tutorial",
  "intro",
  "outro",
  "discussion",
  "demo",
]);
export type SectionAngle = z.infer<typeof SectionAngle>;

/** 候选片段 */
export const SectionCandidateSchema = z.object({
  id: z.string().describe("唯一标识，如 section-1"),
  title: z.string().describe("短标题，10字以内"),
  summary: z.string().describe("一句话总结该片段的核心观点"),
  article_section: z.string().describe("对应的文章章节标题"),
  angle: SectionAngle.describe("片段类型"),
  risk: z.enum(["low", "medium", "high"]).describe("风险等级"),
  timecodes: TimecodeSchema,
  scores: SectionScoresSchema,
  key_quote: z.string().describe("字幕中最具传播力的一句原文"),
  video_script: z.string().describe("视频片段里发生了什么画面"),
  skip_reason: z.string().nullable().optional().describe("跳过原因，有视频画面时为 null"),
});

export type SectionCandidate = z.infer<typeof SectionCandidateSchema>;

/** LLM 输出完整结构 */
export const DeconstructLlmOutputSchema = z.object({
  sections: z.array(SectionCandidateSchema).min(1).max(30).describe("所有识别到的章节候选（含跳过的）"),
});

export type DeconstructLlmOutput = z.infer<typeof DeconstructLlmOutputSchema>;

/** 单个候选的持久化格式（manifest 用） */
export const ClipEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
  series: z.string().optional(),
  title: z.string(),
  type: z.string(),
  angle: z.string(),
  risk: z.string(),
  selected: z.boolean().optional().describe("是否被用户选中保留"),
  charCount: z.number().optional(),
  firstLineChars: z.number().optional(),
  timecodes: TimecodeSchema,
  video: z.string().describe("视频文件名"),
  scores: SectionScoresSchema.optional(),
  text: z.string().optional().describe("优化后的文案"),
  articleReference: z.string().optional(),
  articleSection: z.string().optional(),
  viralHook: z.string().optional(),
  nextTeaser: z.string().optional().describe("下一集预告文案"),
  postTitle: z.string().optional().describe("LLM 生成的帖子标题"),
});

export type ClipEntry = z.infer<typeof ClipEntrySchema>;

/** 完整 manifest */
export const DeconstructManifestSchema = z.object({
  v: z.literal(1),
  source: z.object({
    videoId: z.string(),
    videoUrl: z.string().optional(),
    title: z.string().optional(),
    articlePath: z.string(),
    durationSec: z.number(),
  }),
  generatedAt: z.string(),
  candidateCount: z.number(),
  total: z.number().optional(),
  deconstructionRef: z.string().optional(),
  clips: z.array(ClipEntrySchema),
});

export type DeconstructManifest = z.infer<typeof DeconstructManifestSchema>;

/** deconstruct 命令输入 */
export type DeconstructInput = {
  articleDir: string;
  articleMd: string;
  srtContent: string;
  videoPath: string;
  videoId: string;
  videoUrl?: string;
  durationSec: number;
};

/** deconstruct 命令输出 */
export type DeconstructOutput = {
  manifest: DeconstructManifest;
  clippedPaths: string[];
};
