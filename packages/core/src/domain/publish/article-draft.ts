import { z } from "zod";

export const ArticleDraftMediaSchema = z.object({
  path: z.string().min(1),
  blockIndex: z.number().int().min(0),
  alt: z.string().default(""),
  afterText: z.string().default(""),
});
export type ArticleDraftMedia = z.infer<typeof ArticleDraftMediaSchema>;

export const ArticleDraftDividerSchema = z.object({
  blockIndex: z.number().int().min(0),
  afterText: z.string().default(""),
});
export type ArticleDraftDivider = z.infer<typeof ArticleDraftDividerSchema>;

export const ArticleDraftCodeBlockSchema = z.object({
  code: z.string(),
  language: z.string().default(""),
  blockIndex: z.number().int().min(0),
  afterText: z.string().default(""),
});
export type ArticleDraftCodeBlock = z.infer<typeof ArticleDraftCodeBlockSchema>;

export const ArticleDraftParseResultSchema = z.object({
  title: z.string().min(1),
  coverImage: z.string().min(1).nullable(),
  contentImages: z.array(ArticleDraftMediaSchema),
  contentVideos: z.array(ArticleDraftMediaSchema).default([]),
  contentCodeBlocks: z.array(ArticleDraftCodeBlockSchema).default([]),
  dividers: z.array(ArticleDraftDividerSchema),
  html: z.string(),
  htmlBlocks: z.array(z.string()).default([]),
  totalBlocks: z.number().int().min(0),
});
export type ArticleDraftParseResult = z.infer<typeof ArticleDraftParseResultSchema>;
