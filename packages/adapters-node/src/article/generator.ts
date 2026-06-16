import {
  ARTICLE_X_SYSTEM_PROMPT,
  buildArticleUserPrompt,
  type AvailableVisual,
  type ArticleVisualPlanItem,
  type LlmPort,
} from "@yt2x/core";
import type { StructuredNotesArtifacts } from "./file-store.js";

export type GenerateXArticleInput = {
  llm: LlmPort;
  model: string;
  temperature?: number;
  maxTokens?: number;
  artifacts: StructuredNotesArtifacts;
  /** 可用截图列表；null/[] 表示无可用截图 */
  availableVisuals?: AvailableVisual[] | null;
  signal?: AbortSignal;
};

export type GenerateXArticleResult = {
  content: string;
  /** 长文生成的配图计划 */
  visualPlan: ArticleVisualPlanItem[];
  model: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
};

const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
const stripCodeFenceWrapper = (s: string): string => {
  const m = s.match(FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

const TRAILING_SOURCE_LINE_RE = /\n+(?:来源|Source)\s*[:：][^\n]*\s*$/i;
const stripTrailingSourceAttribution = (s: string): string => s.replace(TRAILING_SOURCE_LINE_RE, "").trim();

const ARTICLE_TOPIC_TAG_RE = /#[\p{L}\p{N}_]+/gu;
const ARTICLE_TOPIC_TAG_REPAIR_PROMPT = `你刚才输出的 X 长文缺少合规的文末话题标签。
请返回修正后的完整 Markdown，保持正文事实、结构和图片引用不变。
最后一个非空行必须只包含 3-5 个从文章主题提取的 X 话题标签，格式如 \`#话题一 #话题二 #TopicThree\`。
标签行之后不要追加来源说明、链接、解释或固定尾注。`;
const ARTICLE_LIST_IMAGE_ERROR =
  "Article image references must be standalone blocks outside ordered or unordered lists.";
const ARTICLE_LIST_IMAGE_REPAIR_PROMPT = `你刚才输出的 X 长文把截图引用放进了列表上下文。
请返回修正后的完整 Markdown，保持正文事实、结构、话题标签和图片引用路径不变。
每张 Markdown 图片必须是列表外的独立段落：不要把图片写成有序 / 无序列表项，不要缩进到列表项内部，也不要插在同一列表的两个列表项之间。
如果图片解释的是某个清单，优先把它移到完整列表之后。`;

/** 校验 LLM 正文最后一行是 3-5 个从主题提取的话题标签。 */
export const validateArticleTopicHashtags = (content: string): string[] => {
  const lastLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
  const tags = lastLine?.match(ARTICLE_TOPIC_TAG_RE) ?? [];
  const remainder = lastLine?.replace(ARTICLE_TOPIC_TAG_RE, "").trim() ?? "";
  if (tags.length < 3 || tags.length > 5 || remainder !== "") {
    throw new Error(
      "Article must end with a standalone line of 3-5 topic hashtags extracted from the source.",
    );
  }
  return tags;
};

/** 从 Markdown 中提取所有图片引用 `![caption](screenshots/<file>)` */
const extractImageRefs = (content: string): Array<{ caption: string; file: string }> => {
  const re = /!\[([^\]]*)\]\(screenshots\/([^)]+)\)/g;
  const refs: Array<{ caption: string; file: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    refs.push({ caption: m[1] ?? "", file: m[2] ?? "" });
  }
  return refs;
};

const ARTICLE_LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+/;
const ARTICLE_SCREENSHOT_REF_RE = /!\[[^\]]*\]\(screenshots\/[^)]+\)/;

const findNeighborLine = (
  lines: readonly string[],
  start: number,
  step: -1 | 1,
): string | undefined => {
  for (let i = start + step; i >= 0 && i < lines.length; i += step) {
    const line = lines[i]!;
    if (line.trim() !== "") return line;
  }
  return undefined;
};

/**
 * 列表内图片会让 X Article 粘贴和移动端阅读都变差。
 * 拦截三种最常见 Markdown 形态：图片列表项、缩进在列表项下、同一列表项之间的图片段落。
 */
const assertArticleImagesOutsideLists = (content: string): void => {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!ARTICLE_SCREENSHOT_REF_RE.test(line)) continue;
    const previous = findNeighborLine(lines, i, -1);
    const next = findNeighborLine(lines, i, 1);
    const isImageListItem = ARTICLE_LIST_ITEM_RE.test(line);
    const isIndentedUnderListItem = /^\s+!\[/.test(line) && previous !== undefined &&
      ARTICLE_LIST_ITEM_RE.test(previous);
    const isBetweenListItems = previous !== undefined && next !== undefined &&
      ARTICLE_LIST_ITEM_RE.test(previous) && ARTICLE_LIST_ITEM_RE.test(next);
    if (isImageListItem || isIndentedUnderListItem || isBetweenListItems) {
      throw new Error(ARTICLE_LIST_IMAGE_ERROR);
    }
  }
};

/** 查找图片引用所在的小节标题 */
const findTargetSection = (content: string, file: string): string => {
  const lines = content.split("\n");
  let currentHeading = "正文";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentHeading = line.slice(3).trim();
    }
    if (line.includes(file)) return currentHeading;
  }
  return currentHeading;
};

/**
 * 验证长文中的图片引用：只允许引用 available_visuals 中存在的截图，拒绝引用不存在的 visual_id。
 */
export const validateArticleVisualPlan = (
  content: string,
  availableVisuals: AvailableVisual[] | null | undefined,
): ArticleVisualPlanItem[] => {
  const refs = extractImageRefs(content);
  if (refs.length === 0) return [];
  assertArticleImagesOutsideLists(content);

  const visuals = availableVisuals ?? [];
  if (visuals.length === 0) {
    throw new Error(
      `Article contains ${refs.length} image reference(s) but no available_visuals were provided. Remove image references or provide screenshots.`,
    );
  }

  const plan: ArticleVisualPlanItem[] = [];
  const validFiles = new Set(visuals.map((v) => v.path.replace(/^screenshots\//, "")));
  const validIds = new Set(visuals.map((v) => v.visual_id));

  for (const ref of refs) {
    const normalizedFile = ref.file.replace(/^screenshots\//, "");
    if (!validFiles.has(normalizedFile) && !validIds.has(ref.file)) {
      throw new Error(
        `Article references image "${ref.file}" which is not in available_visuals. ` +
          `Available: [${visuals.map((v) => v.visual_id).join(", ")}]. Remove the reference or pick an available screenshot.`,
      );
    }
    plan.push({
      target: findTargetSection(content, ref.file),
      visual_id: visuals.find((v) => v.path.endsWith(normalizedFile))?.visual_id ?? ref.file,
      caption: ref.caption,
      reason: "LLM selected for content illustration",
    });
  }

  return plan;
};

/**
 * 调用 LLM 生成 X 长文 `article.md` 正文（不落盘）。
 */
export const generateXArticleContent = async (
  input: GenerateXArticleInput,
): Promise<GenerateXArticleResult> => {
  const userPrompt = buildArticleUserPrompt(
    {
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
      availableVisuals: input.availableVisuals ?? null,
    },
    { platform: "x" },
  );

  const t0 = Date.now();
  const messages = [
    { role: "system" as const, content: ARTICLE_X_SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt },
  ];
  let resp = await input.llm.chat({
    model: input.model,
    messages,
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let content = stripTrailingSourceAttribution(stripCodeFenceWrapper(resp.content.trim()));
  try {
    validateArticleTopicHashtags(content);
  } catch {
    resp = await input.llm.chat({
      model: input.model,
      messages: [
        ...messages,
        { role: "assistant", content: resp.content },
        { role: "user", content: ARTICLE_TOPIC_TAG_REPAIR_PROMPT },
      ],
      temperature: input.temperature ?? 0.55,
      maxTokens: input.maxTokens ?? 16384,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    content = stripTrailingSourceAttribution(stripCodeFenceWrapper(resp.content.trim()));
    validateArticleTopicHashtags(content);
  }

  // 验证图片引用；列表内插图可用一次修复回合把图片移到列表边界外。
  let visualPlan: ArticleVisualPlanItem[];
  try {
    visualPlan = validateArticleVisualPlan(content, input.availableVisuals);
  } catch (err: unknown) {
    if (!(err instanceof Error) || err.message !== ARTICLE_LIST_IMAGE_ERROR) {
      throw err;
    }
    resp = await input.llm.chat({
      model: input.model,
      messages: [
        ...messages,
        { role: "assistant", content: content },
        { role: "user", content: ARTICLE_LIST_IMAGE_REPAIR_PROMPT },
      ],
      temperature: input.temperature ?? 0.55,
      maxTokens: input.maxTokens ?? 16384,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    content = stripTrailingSourceAttribution(stripCodeFenceWrapper(resp.content.trim()));
    validateArticleTopicHashtags(content);
    visualPlan = validateArticleVisualPlan(content, input.availableVisuals);
  }

  // Post-process: ensure Simplified Chinese output regardless of model preference
  try {
    const { simplifyChinese } = await import("../acquire/simplify-chinese.js");
    content = await simplifyChinese(content);
  } catch {
    // If conversion fails, keep original content
  }

  const result: GenerateXArticleResult = {
    content,
    visualPlan,
    model: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
