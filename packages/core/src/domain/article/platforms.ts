import { z } from "zod";

export const PLATFORM_ARTICLE_TARGETS = ["xiaohongshu", "wechat", "bilibili"] as const;
export const PLATFORM_ARTICLE_TARGET_ALL = "all-platforms";

export type PlatformArticleTarget = (typeof PLATFORM_ARTICLE_TARGETS)[number];

export type PlatformArticleSourcePolicy = "source-only" | "allow-background" | "allow-cited-research";

export type PlatformArticleAdaptationMode =
  | "preserve-claims"
  | "minimal-rewrite"
  | "platform-native-restructure";

export type PlatformArticleOutputFile = {
  path: string;
  description: string;
};

export type PlatformArticleSpec = {
  target: PlatformArticleTarget;
  displayName: string;
  source: "article";
  sourcePolicy: PlatformArticleSourcePolicy;
  adaptationMode: PlatformArticleAdaptationMode;
  outputs: readonly PlatformArticleOutputFile[];
  titleOptions: number;
  tags: {
    enabled: boolean;
    min: number;
    max: number;
  };
  coverSuggestion: boolean;
  timelineSuggestion: boolean;
  tone: string;
  format: string;
};

export const PLATFORM_ARTICLE_SPECS = {
  xiaohongshu: {
    target: "xiaohongshu",
    displayName: "小红书",
    source: "article",
    sourcePolicy: "source-only",
    adaptationMode: "preserve-claims",
    outputs: [
      {
        path: "xiaohongshu-format/xiaohongshu-article.md",
        description: "小红书图文笔记文案，包含统一标题、正文和核心标签。",
      },
      {
        path: "xiaohongshu-format/xiaohongshu-metadata.json",
        description: "小红书标题、标签、封面/配图建议等结构化元数据。",
      },
    ],
    titleOptions: 5,
    tags: {
      enabled: true,
      min: 3,
      max: 5,
    },
    coverSuggestion: true,
    timelineSuggestion: false,
    tone: "种草型、强情绪、强钩子，同时保持信息密度。",
    format: "图文笔记文案 + 封面/配图建议。",
  },
  wechat: {
    target: "wechat",
    displayName: "微信公众号",
    source: "article",
    sourcePolicy: "source-only",
    adaptationMode: "preserve-claims",
    outputs: [
      {
        path: "wechat-format/wechat-article.md",
        description: "适合公众号排版发布的完整 Markdown 长文。",
      },
      {
        path: "wechat-format/wechat-metadata.json",
        description: "公众号标题候选、摘要、导语和封面图建议。",
      },
    ],
    titleOptions: 4,
    tags: {
      enabled: false,
      min: 0,
      max: 0,
    },
    coverSuggestion: true,
    timelineSuggestion: false,
    tone: "完整长文、结构清晰、适合公众号阅读节奏。",
    format: "Markdown 长文 + 摘要/导语 + 封面图建议。",
  },
  bilibili: {
    target: "bilibili",
    displayName: "哔哩哔哩",
    source: "article",
    sourcePolicy: "source-only",
    adaptationMode: "preserve-claims",
    outputs: [
      {
        path: "bilibili-format/bilibili-article.md",
        description: "哔哩哔哩视频简介、标题候选、分区和标签建议。",
      },
      {
        path: "bilibili-format/bilibili-metadata.json",
        description: "哔哩哔哩标题、分区、标签和章节时间线草案。",
      },
    ],
    titleOptions: 1,
    tags: {
      enabled: true,
      min: 8,
      max: 10,
    },
    coverSuggestion: false,
    timelineSuggestion: true,
    tone: "强冲突、高点击，兼顾知识区可读性。",
    format: "视频标题 + 简介 + 分区/标签建议 + 章节时间线草案。",
  },
} as const satisfies Record<PlatformArticleTarget, PlatformArticleSpec>;

export const getPlatformArticleSpec = (target: PlatformArticleTarget): PlatformArticleSpec =>
  PLATFORM_ARTICLE_SPECS[target];

const PLATFORM_ARTICLE_TARGET_SET = new Set<string>(PLATFORM_ARTICLE_TARGETS);

const splitPlatformTargets = (raw: string): string[] =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const parsePlatformArticleTargets = (
  raw: string | readonly string[] | undefined,
): PlatformArticleTarget[] => {
  if (raw === undefined) return [];

  const parts = typeof raw === "string" ? splitPlatformTargets(raw) : raw.flatMap(splitPlatformTargets);
  if (parts.length === 0) return [];

  const expanded = parts.includes(PLATFORM_ARTICLE_TARGET_ALL) ? [...PLATFORM_ARTICLE_TARGETS] : parts;
  const invalid = expanded.filter((target) => !PLATFORM_ARTICLE_TARGET_SET.has(target));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --platform-targets value "${invalid[0]}". Expected one of: ${[
        ...PLATFORM_ARTICLE_TARGETS,
        PLATFORM_ARTICLE_TARGET_ALL,
      ].join(", ")}`,
    );
  }

  const deduped: PlatformArticleTarget[] = [];
  for (const target of expanded) {
    if (!deduped.includes(target as PlatformArticleTarget)) {
      deduped.push(target as PlatformArticleTarget);
    }
  }
  return deduped;
};

export const PlatformArticleTargetsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((raw, ctx) => {
    try {
      return parsePlatformArticleTargets(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
  });
