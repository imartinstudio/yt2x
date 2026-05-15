import { z } from "zod";

export const StageModeSchema = z.enum(["auto", "review", "skip"]);
export type StageMode = z.infer<typeof StageModeSchema>;

export const ErrorStrategySchema = z.enum(["stop", "skip"]);
export type ErrorStrategy = z.infer<typeof ErrorStrategySchema>;

export const RewriteModeSchema = z.enum(["rules", "llm"]);
export type RewriteMode = z.infer<typeof RewriteModeSchema>;

export const PlatformSchema = z.enum([
  "x",
  "wechat",
  "newsletter",
  "linkedin",
  "blog",
  "threads",
  "xiaohongshu",
]);
export type PlatformId = z.infer<typeof PlatformSchema>;

export const VerbosityFlags = z.object({
  verbose: z.boolean().default(false),
});
export type VerbosityFlags = z.infer<typeof VerbosityFlags>;
