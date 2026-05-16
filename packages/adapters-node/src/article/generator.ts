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
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: ARTICLE_X_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const content = stripCodeFenceWrapper(resp.content.trim());

  // 验证图片引用
  const visualPlan = validateArticleVisualPlan(content, input.availableVisuals);

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
