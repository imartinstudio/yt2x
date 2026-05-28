import { z } from "zod";
import { ArticleOutputTargetsSchema } from "@yt2x/core";
import {
  ErrorStrategySchema,
  PlatformSchema,
  RewriteModeSchema,
  StageModeSchema,
  VerbosityFlags,
} from "./common.js";
import { LlmConfigSchema } from "./llm.js";

export const SearchSortSchema = z.enum(["views"]);

export const VideoSourcesFieldsSchema = z
  .object({
    urls: z.array(z.string().url()).default([]),
    urlFile: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    searchSort: SearchSortSchema.optional(),
  })
  .refine((data) => data.searchSort === undefined || data.search !== undefined, {
    message: "--search-sort 需要同时提供 --search",
    path: ["searchSort"],
  });

export type VideoSourcesFields = z.infer<typeof VideoSourcesFieldsSchema>;

export const hasVideoSources = (sources: VideoSourcesFields): boolean =>
  sources.urls.length > 0 || sources.urlFile !== undefined || sources.search !== undefined;

/** 单阶段命令（如 `acquire`）仍要求显式来源。 */
export const VideoSourcesSchema = VideoSourcesFieldsSchema.refine(hasVideoSources, {
  message: "必须提供 --urls、--url-file 或 --search 之一",
  path: ["urls"],
});

export const StageModesSchema = z.object({
  acquire: StageModeSchema.default("auto"),
  notes: StageModeSchema.default("review"),
  article: StageModeSchema.default("review"),
  publish: StageModeSchema.default("review"),
});
export type StageModes = z.infer<typeof StageModesSchema>;

export const AcquireOptionsSchema = z.object({
  keyframes: z.coerce.number().int().min(0).default(0),
  jobs: z.coerce.number().int().min(1).default(3),
  subLangs: z.string().optional(),
  sceneThreshold: z.coerce.number().min(0).default(0.35),
  sceneMinGap: z.coerce.number().min(0).default(12),
  maxWords: z.coerce.number().int().min(100).default(900),
  cookiesFromBrowser: z.string().default("chrome"),
  proxy: z.string().optional(),
  downloadVideo: z.boolean().default(true),
  videoOnly: z.boolean().default(false),
  videoStart: z.string().optional(),
  videoEnd: z.string().optional(),
  videoDuration: z.coerce.number().int().min(1).max(600).default(30),
}).superRefine((data, ctx) => {
  if (data.videoOnly && data.downloadVideo === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "--video-only 不能与 --no-download-video 同时使用",
      path: ["downloadVideo"],
    });
  }
});
export type AcquireOptions = z.infer<typeof AcquireOptionsSchema>;

export const ArticleOptionsSchema = z.object({
  platform: PlatformSchema.default("x"),
  maxChars: z.coerce.number().int().min(1).default(280),
  rewriteMode: RewriteModeSchema.default("rules"),
  targets: ArticleOutputTargetsSchema.default("all"),
});
export type ArticleOptions = z.infer<typeof ArticleOptionsSchema>;

export const PublishFormatSchema = z.enum(["article", "thread"]);

export const PublishOptionsSchema = z.object({
  publishDryRun: z.boolean().default(false),
  /** `article`：长文章草稿 / 预览（默认）；`thread`：按生成串推发布 */
  format: PublishFormatSchema.default("article"),
  maxChars: z.coerce.number().int().min(1).default(500),
  maxTweets: z.coerce.number().int().min(1).max(10).default(8),
  threadDelay: z.string().default("20-30"),
});
export type PublishOptions = z.infer<typeof PublishOptionsSchema>;

export const ControlOptionsSchema = z.object({
  outDir: z.string().optional(),
  continueFlag: z.boolean().default(false),
  errorStrategy: ErrorStrategySchema.default("stop"),
  /** 覆盖已有 structured-notes.md 等产物（native notes 阶段） */
  force: z.boolean().default(false),
});
export type ControlOptions = z.infer<typeof ControlOptionsSchema>;

export const PipelineArgsSchema = z
  .object({
    sources: VideoSourcesFieldsSchema,
    stages: StageModesSchema,
    acquire: AcquireOptionsSchema,
    article: ArticleOptionsSchema,
    publish: PublishOptionsSchema,
    control: ControlOptionsSchema,
    llm: LlmConfigSchema,
    flags: VerbosityFlags,
  })
  .superRefine((data, ctx) => {
    if (data.control.continueFlag || data.stages.acquire === "skip") return;
    if (hasVideoSources(data.sources)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "必须提供 --urls、--url-file 或 --search 之一",
      path: ["sources", "urls"],
    });
  });
export type PipelineArgs = z.infer<typeof PipelineArgsSchema>;
