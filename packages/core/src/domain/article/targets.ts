import { z } from "zod";

export const ARTICLE_OUTPUT_TARGETS = ["article", "x-thread", "x-short", "x-video-short"] as const;
export const ARTICLE_OUTPUT_TARGET_ALL = "all";
export const LEGACY_ARTICLE_OUTPUT_TARGET_LONGFORM = "x-longform";

export type ArticleOutputTarget = (typeof ARTICLE_OUTPUT_TARGETS)[number];
export type ArticleOutputTargetInput = ArticleOutputTarget | typeof ARTICLE_OUTPUT_TARGET_ALL;

const ARTICLE_OUTPUT_TARGET_SET = new Set<string>(ARTICLE_OUTPUT_TARGETS);

export const DEFAULT_ARTICLE_OUTPUT_TARGETS: readonly ArticleOutputTarget[] = ["article"];

const splitTargets = (raw: string): string[] =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const parseArticleOutputTargets = (
  raw: string | readonly string[] | undefined,
): ArticleOutputTarget[] => {
  if (raw === undefined) return [...DEFAULT_ARTICLE_OUTPUT_TARGETS];

  const parts = typeof raw === "string" ? splitTargets(raw) : raw.flatMap(splitTargets);
  if (parts.length === 0) return [...DEFAULT_ARTICLE_OUTPUT_TARGETS];

  const expanded = parts.includes(ARTICLE_OUTPUT_TARGET_ALL) ? [...ARTICLE_OUTPUT_TARGETS] : parts;
  const normalized = expanded.map((target) =>
    target === LEGACY_ARTICLE_OUTPUT_TARGET_LONGFORM ? "article" : target,
  );
  const invalid = normalized.filter((target) => !ARTICLE_OUTPUT_TARGET_SET.has(target));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --targets value "${invalid[0]}". Expected one of: ${[
        ...ARTICLE_OUTPUT_TARGETS,
        LEGACY_ARTICLE_OUTPUT_TARGET_LONGFORM,
        ARTICLE_OUTPUT_TARGET_ALL,
      ].join(", ")}`,
    );
  }

  const deduped: ArticleOutputTarget[] = [];
  for (const target of normalized) {
    if (!deduped.includes(target as ArticleOutputTarget)) {
      deduped.push(target as ArticleOutputTarget);
    }
  }
  return deduped;
};

export const ArticleOutputTargetsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((raw, ctx) => {
    try {
      return parseArticleOutputTargets(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
  });
