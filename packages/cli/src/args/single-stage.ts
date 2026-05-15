import { z } from "zod";
import { VerbosityFlags } from "./common.js";
import { LlmConfigSchema } from "./llm.js";
import {
  AcquireOptionsSchema,
  ArticleOptionsSchema,
  ControlOptionsSchema,
  PublishOptionsSchema,
  VideoSourcesSchema,
} from "./pipeline.js";

/**
 * 单阶段命令的参数 schema：每个命令只保留它真正需要的字段，
 * 避免 `--all-flags-for-every-subcommand` 的 AI 坏味道。
 */

export const AcquireCommandArgsSchema = z.object({
  sources: VideoSourcesSchema,
  acquire: AcquireOptionsSchema,
  control: ControlOptionsSchema,
  flags: VerbosityFlags,
});
export type AcquireCommandArgs = z.infer<typeof AcquireCommandArgsSchema>;

export const NotesCommandArgsSchema = z.object({
  sources: VideoSourcesSchema,
  control: ControlOptionsSchema,
  llm: LlmConfigSchema,
  flags: VerbosityFlags,
});
export type NotesCommandArgs = z.infer<typeof NotesCommandArgsSchema>;

export const ArticleCommandArgsSchema = z.object({
  sources: VideoSourcesSchema,
  article: ArticleOptionsSchema,
  control: ControlOptionsSchema,
  llm: LlmConfigSchema,
  flags: VerbosityFlags,
});
export type ArticleCommandArgs = z.infer<typeof ArticleCommandArgsSchema>;

export const PublishCommandArgsSchema = z.object({
  sources: VideoSourcesSchema,
  publish: PublishOptionsSchema,
  control: ControlOptionsSchema,
  flags: VerbosityFlags,
});
export type PublishCommandArgs = z.infer<typeof PublishCommandArgsSchema>;
