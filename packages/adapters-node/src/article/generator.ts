import {
  buildArticleLeadTightenPrompt,
  findOverlongArticleLead,
  ARTICLE_X_SYSTEM_PROMPT,
  appendTechnicalTermRuleToSystemPrompt,
  buildArticleUserPrompt,
  createTechnicalTermGuard,
  hasHardTechnicalTermViolations,
  type AvailableVisual,
  type ArticleVisualPlanItem,
  type FinalizedTechnicalTermValue,
  type LlmPort,
  type TechnicalTermGuard,
} from "@yt2x/core";
import {
  createFileTechnicalTermDiscoveryCacheStore,
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  knownSourceTextWithMetadata,
  structuredNotesContentSourceFor,
  summarySourceTextFor,
} from "../content-cache.js";
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
  /** 目标侧持久化 discovery cache；不得指向 files/downloads。 */
  technicalTermDiscoveryCacheDir?: string;
};

export type GenerateXArticleResult = {
  content: string;
  /** 长文生成的配图计划 */
  visualPlan: ArticleVisualPlanItem[];
  model: string;
  requestedModel: string;
  resolvedModel: string;
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens?: number };
  videoId: string;
  durationMs: number;
  technicalTermProfileFingerprint: string;
  technicalTermDiscovery: ReturnType<typeof technicalTermDiscoveryAuditFor>;
  sourceFingerprint: string;
  promptVersion: string;
};

const FENCE_RE = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/;
const stripCodeFenceWrapper = (s: string): string => {
  const m = s.match(FENCE_RE);
  return m !== null && m[1] !== undefined ? m[1].trim() : s;
};

const TRAILING_SOURCE_LINE_RE = /\n+(?:来源|Source)\s*[:：][^\n]*\s*$/i;
const stripTrailingSourceAttribution = (s: string): string => s.replace(TRAILING_SOURCE_LINE_RE, "").trim();
const ARTICLE_H1_RE = /^#\s+.*$/m;
const MARKDOWN_H1_TEXT_RE = /^#\s+(.+?)\s*$/m;

const restoreProtectedProductNames = (translatedTitle: string, sourceTitle: string): string => {
  let title = translatedTitle;
  if (/\bClaude Design\b/i.test(sourceTitle)) {
    title = title
      .replace(/Claude\s*设计(?=\p{Script=Han})/giu, "Claude Design ")
      .replace(/Claude\s*设计/gi, "Claude Design");
  }
  return title;
};

/** structured notes 的 H1 是原标题的忠实中文转译；模型生成的营销标题不能覆盖它。 */
const restoreFaithfulChineseTitle = (
  content: string,
  structuredNotesMd: string,
  sourceTitle: unknown,
  guard: TechnicalTermGuard,
): string => {
  const notesTitle = structuredNotesMd.match(MARKDOWN_H1_TEXT_RE)?.[1]
    ?.trim()
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .trim();
  const fallbackTitle = typeof sourceTitle === "string" ? sourceTitle.trim() : "";
  const candidateTitle = notesTitle?.length ? notesTitle : fallbackTitle;
  const title = guard.finalize(
    restoreProtectedProductNames(candidateTitle, fallbackTitle),
    { placeholders: [] },
  ).value;
  if (title.length === 0) return content;
  return content.replace(ARTICLE_H1_RE, `# **${title}**`);
};

const ARTICLE_TOPIC_TAG_RE = /#[\p{L}\p{N}_]+/gu;
const COMMAND_STYLE_TOPIC_TAG_LINE_RE = /^(?:#[/\-\p{L}\p{N}_]+)(?:\s+#[/\-\p{L}\p{N}_]+){2,4}$/u;
const normalizeCommandStyleTopicTag = (tag: string): string => {
  const segments = tag.slice(1).split(/[/-]+/u).filter((segment) => segment.length > 0);
  if (segments.length === 0) return tag;
  return `#${segments.map((segment) =>
    /^[A-Za-z0-9_]+$/u.test(segment)
      ? `${segment[0]!.toUpperCase()}${segment.slice(1)}`
      : segment,
  ).join("")}`;
};

/** X 标签不能包含命令前缀或连字符，将原始命令名规范化为可发布标签。 */
const normalizeCommandStyleTopicHashtags = (content: string): string => {
  const lines = content.split(/\r?\n/);
  const lastIndex = lines.findLastIndex((line) => line.trim().length > 0);
  if (lastIndex < 0) return content;
  const lastLine = lines[lastIndex]!.trim();
  if (!lastLine.includes("/") && !lastLine.includes("-")) return content;
  if (!COMMAND_STYLE_TOPIC_TAG_LINE_RE.test(lastLine)) return content;
  lines[lastIndex] = lastLine.split(/\s+/u).map(normalizeCommandStyleTopicTag).join(" ");
  return lines.join("\n");
};
const ARTICLE_TOPIC_TAG_REPAIR_PROMPT = `你刚才输出的 X 长文缺少合规的文末话题标签。
请返回修正后的完整 Markdown，保持正文事实、结构和图片引用不变。
最后一个非空行必须只包含 3-5 个从文章主题提取的 X 话题标签，格式如 \`#话题一 #话题二 #TopicThree\`。
命令名必须转成可发布标签：\`/wayfinder\` 写成 \`#Wayfinder\`，\`/to-spec\` 写成 \`#ToSpec\`；标签中不能保留 \`/\` 或 \`-\`。
标签行之后不要追加来源说明、链接、解释或固定尾注。`;
const ARTICLE_TOPIC_TAG_ONLY_REPAIR_PROMPT = `完整文章修复仍未提供合规的话题标签。现在只返回一行 3-5 个从原视频主题和文章正文提取的 X 话题标签，不要返回文章正文。
格式必须是：\`#话题一 #话题二 #TopicThree\`。
不要添加「话题标签：」等前缀、标点、解释、代码围栏或其他文字；如果标签含有命令名，去掉 \`/\` 和 \`-\` 并转成 PascalCase。`;
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
/**
 * Rewrite the lead when it overruns ARTICLE_LEAD_MAX_CHARS.
 *
 * The limit lived only in the checker, which merely logged `lead-too-long`
 * after the article was already on disk. Stating it in the prompt (b79ed52) was
 * necessary but not sufficient — the model overshot anyway, 152 chars against
 * 120 on the run that prompted this. Nothing corrected it, so the warning fired
 * on delivery and stayed.
 *
 * One attempt, not a loop: the lead is a single paragraph and the measurements
 * say the limit is reachable — two of three real articles already satisfy it —
 * so this is correcting an occasional overshoot, not fighting a systematic one.
 * If the rewrite still does not fit, or drops a protected term, the original
 * stands and the checker's warning is left to report it. A worse lead that fits
 * is not an improvement.
 */
const MAX_LEAD_TIGHTEN_ROUNDS = 3;

/**
 * Rewrite the lead when it overruns ARTICLE_LEAD_MAX_CHARS.
 *
 * The limit lived only in the checker, which merely logged `lead-too-long` after
 * the article was already on disk. Stating it in the prompt (b79ed52) was
 * necessary but not sufficient — the model overshot anyway, 152-168 chars against
 * 120 — and nothing corrected it.
 *
 * Bounded loop rather than one attempt, and it accepts progress rather than
 * demanding a hit. A single attempt on real material compressed 165 -> 127,
 * which an all-or-nothing rule then threw away in favour of the 165-char
 * original — strictly the worse artifact. Feeding the shortened lead back in
 * gets the rest of the way.
 *
 * The opposite failure is just as real: the dub's tighten pass accepted anything
 * merely shorter and so never converged (see MAX_TIGHTEN_ROUNDS in
 * dub/translate.ts). So each round must be strictly shorter than the last, the
 * loop stops as soon as it fits, and it gives up when a round stops improving —
 * every extra round is a provider call.
 *
 * A rewrite that drops a protected term is rejected outright: a long lead is a
 * warning, a mangled product name is wrong.
 */
const tightenOverlongLead = async (
  content: string,
  finalize: (value: string) => Promise<FinalizedTechnicalTermValue<string>>,
  input: GenerateXArticleInput,
): Promise<string> => {
  let current = content;

  for (let attempt = 0; attempt < MAX_LEAD_TIGHTEN_ROUNDS; attempt += 1) {
    const overlong = findOverlongArticleLead(current);
    if (overlong === null) return current;

    const decline = (reason: string): string => {
      console.warn(
        `article lead tighten stopped after round ${attempt + 1} (${reason}); `
        + `shipping a ${overlong.length}-char lead against a ${overlong.limit} limit`,
      );
      return current;
    };

    let rewritten: string;
    try {
      const resp = await input.llm.chat({
        model: input.model,
        messages: [
          { role: "system", content: buildArticleLeadTightenPrompt(overlong.length, overlong.limit) },
          { role: "user", content: overlong.lead },
        ],
        temperature: 0.3,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      rewritten = stripCodeFenceWrapper(resp.content.trim()).trim();
    } catch (err: unknown) {
      return decline(err instanceof Error ? err.message : String(err));
    }

    if (rewritten === "") return decline("empty rewrite");
    if (rewritten.includes("\n\n")) return decline("rewrite returned more than one paragraph");
    if (overlong.start < 0) return decline("lead span not locatable in article");
    const candidate = current.slice(0, overlong.start) + rewritten + current.slice(overlong.end);
    // One measure, taken from core, for both questions — "did it get shorter"
    // and "does it fit now". Re-deriving the length here is how a repair ends up
    // chasing a different number than the check it is trying to satisfy.
    const candidateOverlong = findOverlongArticleLead(candidate);
    if (candidateOverlong !== null && candidateOverlong.length >= overlong.length) {
      // Don't take it, but do ask again. The dub's tighten pass stops on a
      // fruitless round because one round there spans 20+ lines, so "nothing
      // improved" really is a plateau. Here a round is a single paragraph and a
      // single sample — observed declining at 137 chars against a 120 limit,
      // close enough that another draw is worth one call.
      console.warn(
        `article lead tighten round ${attempt + 1} was not shorter `
        + `(${candidateOverlong.length} chars); retrying`,
      );
      continue;
    }

    const finalized = await finalize(candidate);
    if (finalized.value.includes(rewritten) === false) {
      return decline("term guard rejected the rewrite");
    }
    current = finalized.value;

    const remaining = findOverlongArticleLead(current);
    if (remaining === null) {
      console.warn(
        `article lead tightened from ${overlong.length} chars to within the `
        + `${overlong.limit} limit in ${attempt + 1} round(s)`,
      );
      return current;
    }
  }

  const left = findOverlongArticleLead(current);
  if (left !== null) {
    console.warn(
      `article lead still ${left.length} chars after ${MAX_LEAD_TIGHTEN_ROUNDS} tighten round(s); `
      + `shipping it and letting the quality report say so`,
    );
  }
  return current;
};

export const generateXArticleContent = async (
  input: GenerateXArticleInput,
): Promise<GenerateXArticleResult> => {
  const sourceText = input.artifacts.structuredNotesMd;
  const sourceTitle = input.artifacts.metadata.title ?? "";
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    sourceTitle,
    ...(input.technicalTermDiscoveryCacheDir === undefined
      ? {}
      : { cache: createFileTechnicalTermDiscoveryCacheStore(input.technicalTermDiscoveryCacheDir) }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const discoveryAudit = technicalTermDiscoveryAuditFor(discovery, { sourceText, sourceTitle });
  // 已知范围要覆盖 prepare() 递给模型的全部材料：metadata 也在 prompt 里，
  // 只在其中出现的词（作者名、频道名、简介里的产品名）不该被判成凭空造词。
  const fullGuard = createTechnicalTermGuard({
    sourceText: knownSourceTextWithMetadata(input.artifacts.metadata, sourceText),
    sourceTitle,
    discoveredTerms: discovery.accepted,
    discovery: discoveryAudit,
  });
  // 完整 notes 仍是已知范围（详细章节里的术语允许出现），但只有摘要范围里的术语
  // 才要求文章必须携带——长文是重写而不是逐条转录，逼它塞进每一个转录术语只会
  // 制造无法修复的失败。
  const guard = fullGuard.scope(summarySourceTextFor(sourceText), sourceTitle);
  const titleGuard = fullGuard.scope(sourceTitle, sourceTitle);
  const prepared = guard.prepare({
    metadata: input.artifacts.metadata,
    structuredNotesMd: input.artifacts.structuredNotesMd,
    availableVisuals: input.availableVisuals ?? null,
  });
  const userPrompt = buildArticleUserPrompt(prepared.value, { platform: "x" });
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(ARTICLE_X_SYSTEM_PROMPT, prepared.promptRule);

  const t0 = Date.now();
  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];
  let resp = await input.llm.chat({
    model: input.model,
    messages,
    temperature: input.temperature ?? 0.55,
    maxTokens: input.maxTokens ?? 16384,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let content = normalizeCommandStyleTopicHashtags(
    stripTrailingSourceAttribution(stripCodeFenceWrapper(resp.content.trim())),
  );
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
    content = normalizeCommandStyleTopicHashtags(
      stripTrailingSourceAttribution(stripCodeFenceWrapper(resp.content.trim())),
    );
    try {
      validateArticleTopicHashtags(content);
    } catch {
      resp = await input.llm.chat({
        model: input.model,
        messages: [
          ...messages,
          { role: "assistant", content: resp.content },
          { role: "user", content: ARTICLE_TOPIC_TAG_ONLY_REPAIR_PROMPT },
        ],
        temperature: 0.2,
        maxTokens: 256,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      const tagLine = normalizeCommandStyleTopicHashtags(
        stripCodeFenceWrapper(resp.content.trim()),
      );
      validateArticleTopicHashtags(tagLine);
      content = `${content.trim()}\n\n${tagLine}`;
    }
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
    validateArticleVisualPlan(content, input.availableVisuals);
  }

  // Post-process: ensure Simplified Chinese and fix common LLM homoglyph errors
  try {
    const { simplifyChinese, fixLlmHomoglyphs } = await import("../acquire/simplify-chinese.js");
    content = await simplifyChinese(content);
    content = fixLlmHomoglyphs(content);
  } catch {
    // If conversion fails, keep original content
  }
  content = restoreFaithfulChineseTitle(
    content,
    input.artifacts.structuredNotesMd,
    input.artifacts.metadata.title,
    titleGuard,
  );

  const finalize = async (
    value: string,
  ): Promise<FinalizedTechnicalTermValue<string>> => {
    let finalized = guard.finalize(value, prepared.restoration);
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      finalized = await repairTechnicalTermViolations({
        llm: input.llm,
        model: input.model,
        guard,
        currentValue: finalized.value,
        restoration: prepared.restoration,
        violations: finalized.violations,
        parseResponse: (raw) => normalizeCommandStyleTopicHashtags(
          stripTrailingSourceAttribution(stripCodeFenceWrapper(raw.trim())),
        ),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }
    if (hasHardTechnicalTermViolations(finalized.violations)) {
      throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
    }
    return finalized;
  };
  content = (await finalize(content)).value;
  content = await tightenOverlongLead(content, finalize, input);
  validateArticleTopicHashtags(content);
  visualPlan = validateArticleVisualPlan(content, input.availableVisuals);

  const result: GenerateXArticleResult = {
    content,
    visualPlan,
    model: resp.model,
    requestedModel: input.model,
    resolvedModel: resp.model,
    finishReason: resp.finishReason,
    videoId: input.artifacts.videoId,
    durationMs: Date.now() - t0,
    technicalTermProfileFingerprint: prepared.profileFingerprint,
    technicalTermDiscovery: discoveryAudit,
    sourceFingerprint: contentSourceFingerprintFor(structuredNotesContentSourceFor({
      metadata: input.artifacts.metadata,
      structuredNotesMd: input.artifacts.structuredNotesMd,
      availableVisuals: input.availableVisuals,
    })),
    promptVersion: CONTENT_PROMPT_VERSIONS.article,
  };
  if (resp.usage !== undefined) result.usage = resp.usage;
  return result;
};
