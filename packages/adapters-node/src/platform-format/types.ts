import type { ImageGeneratorPort } from "../llm/image-generator.js";
import type { PlatformArticleTarget } from "@yt2x/core";
import type { LlmPort } from "@yt2x/core";

// ── shared input / output ──

export type PlatformFormatInput = {
  articleDir: string;
  videoId: string;
  articleMd: string;
  imageGenerator?: ImageGeneratorPort;
  llm?: LlmPort;
  llmModel?: string;
};

export type PlatformFormatResult = {
  outputDir: string;
  files: string[];
  imagesGenerated: number;
};

// ── platform metadata schemas (from *-metadata.json) ──

export type CoverMetadata = {
  headline: string;
  subhead?: string;
  visual_prompt: string;
};

export type WechatMetadata = {
  target: "wechat";
  title: string;
  title_options: string[];
  summary: string;
  lead: string;
  body: string;
  cover: CoverMetadata;
};

export type XiaohongshuMetadata = {
  target: "xiaohongshu";
  title: string;
  body: string;
  tags: string[];
  cover: CoverMetadata;
  notes?: string[];
};

export type BilibiliTimelineItem = {
  time: string;
  title: string;
  description: string;
};

export type BilibiliMetadata = {
  target: "bilibili";
  title: string;
  description: string;
  category: string;
  tags: string[];
  timeline: BilibiliTimelineItem[];
  comment_prompt: string;
};

export type PlatformMetadata = WechatMetadata | XiaohongshuMetadata | BilibiliMetadata;

// ── dispatch ──

export type FormatPlatformFn = (input: PlatformFormatInput) => Promise<PlatformFormatResult>;

export type PlatformFormatters = Record<PlatformArticleTarget, FormatPlatformFn>;
