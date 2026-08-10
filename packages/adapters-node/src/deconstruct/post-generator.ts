import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendTechnicalTermRuleToSystemPrompt,
  CLIP_POST_CALL_TO_ACTION,
  CLIP_POST_SYSTEM_PROMPT,
  createTechnicalTermGuard,
  DeconstructManifestSchema,
  deriveSeriesName,
  hasHardTechnicalTermViolations,
  type FinalizedTechnicalTermValue,
  type ClipPostList,
  type DeconstructManifest,
  type DiscoveredTechnicalTerm,
  type GeneratePostsInput,
  type LlmPort,
  type TechnicalTermDiscoveryAudit,
  type TechnicalTermGuard,
  type TechnicalTermRestoration,
} from "@yt2x/core";
import { ClipPostListSchema } from "@yt2x/core";
import {
  discoverTechnicalTerms,
  repairTechnicalTermViolations,
  technicalTermDiscoveryAuditFor,
} from "../technical-terms/discovery.js";
import {
  CONTENT_PROMPT_VERSIONS,
  contentSourceFingerprintFor,
  contentTechnicalTermSourceFingerprintFor,
  contentTargetMetadataPathFor,
  createContentTargetMetadata,
  isContentTargetMetadataFresh,
  readContentTargetMetadata,
  writeContentTargetMetadata,
} from "../content-cache.js";
import { withContentTargetLock } from "../content-transaction.js";

export type GeneratePostsRunnerInput = {
  llm: LlmPort;
  model: string;
  articleDir: string;
  /** 可选的内存 manifest；用于在所有校验完成前不替换旧 manifest。 */
  manifest?: DeconstructManifest;
  /** false 时只返回内存结果，不触碰 clips/ 下的既有文件。 */
  persist?: boolean;
  /** persist:false 只能由已完成 CLI bundle cache 检查的内部 staging 调用。 */
  cacheContract?: "cli";
  outputDir?: string;
  lock?: boolean;
  signal?: AbortSignal;
};

export type GeneratePostsRunnerResult = {
  postCount: number;
  postPaths: string[];
  manifest: DeconstructManifest;
  technicalTerms: ClipPostTechnicalTerms;
  usage?: { promptTokens: number; completionTokens: number };
};

export type ClipPostTechnicalTerms = {
  guard: TechnicalTermGuard;
  restoration: TechnicalTermRestoration;
  articleTitle: string;
  discoveredTerms: readonly DiscoveredTechnicalTerm[];
  discoveryAudit?: TechnicalTermDiscoveryAudit;
  sourceTextByClipId?: Readonly<Record<string, string>>;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  sourceFingerprint?: string;
  promptVersion?: string;
  profileFingerprint?: string;
};

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripFence = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m ? m[1]!.trim() : s.trim();
};

export const clipsInputForManifest = (manifest: DeconstructManifest): GeneratePostsInput["clips"] =>
  manifest.clips.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.scores?.composite !== undefined
      ? `${c.title}（评分 ${c.scores.composite.toFixed(1)}）：${c.articleSection ?? ""}`
      : c.title,
    angle: c.angle,
    timecodes: { durationSec: Math.round(c.timecodes.durationSec) },
    video: c.video,
  }));

export const clipPostSourceTextFor = (
  articleMd: string,
  manifest: DeconstructManifest,
): string => `${articleMd}\n${JSON.stringify(clipsInputForManifest(manifest))}`;

/**
 * Build user prompt for all candidate clips.
 * Angle is passed as context without enforcing a drama type.
 */
const buildPostUserPrompt = (input: GeneratePostsInput): string => {
  const parts: string[] = [];

  parts.push("## 文章");
  parts.push(`标题：${input.articleTitle}`);
  parts.push(`系列名称：${input.seriesName}`);
  parts.push("");

  parts.push(`## 候选片段（共 ${input.clips.length} 个，按发帖顺序排列）`);
  for (let i = 0; i < input.clips.length; i++) {
    const c = input.clips[i]!;
    parts.push("");
    parts.push(`### 第 ${i + 1} 篇`);
    parts.push(`标题：${c.title}`);
    parts.push(`角度（angle）：${c.angle}`);
    parts.push(`摘要：${c.summary}`);
    parts.push(`视频时长：${c.timecodes.durationSec}秒`);
    parts.push(`文件名：${c.video}`);
  }
  parts.push("");
  parts.push(`请为以上 ${input.clips.length} 个片段各生成一条帖子文案。`);
  parts.push("遵循 Martin AI Coding Workflow 风格：真实体验 > 技术参数，发现 > 功能介绍。");
  parts.push("每条帖子完成后执行最终检查清单（6 项），不满足则重新生成。");
  parts.push("输出的 posts 数组顺序必须与输入顺序一致。");
  parts.push("");
  parts.push("重要提醒：");
  parts.push("- 杜绝 AI 味的「我…」泛泛感慨。如果「我」后面没有具体动作或画面，就不要用「我」。");
  parts.push("- Emoji 0-2 个，贴合上下文才加，不要硬塞。不加 emoji 完全没问题。");
  parts.push("- 所有片段时长均在 120 秒以内，文案节奏需与短视频片段匹配。");

  return parts.join("\n");
};

/**
 * Generate post copy for all candidate clips, writing all to manifest JSON.
 * Only writes separate .md files for clips that are already selected=true.
 */
export const generateClipsPosts = async (
  input: GeneratePostsRunnerInput,
): Promise<GeneratePostsRunnerResult> => {
  if (input.persist === false && input.cacheContract !== "cli") {
    throw new Error("persist:false deconstruct post generation requires the CLI cache contract.");
  }
  if (input.lock !== false && input.persist !== false) {
    return withContentTargetLock(input.articleDir, "deconstruct", () => generateClipsPosts({
      ...input,
      lock: false,
    }));
  }
  const clipsDir = input.outputDir ?? path.join(input.articleDir, "x-format", "clips");
  const manifestPath = path.join(clipsDir, "clips-manifest.json");
  const articlePath = path.join(input.articleDir, "article.md");

  const [manifestRaw, articleMd] = await Promise.all([
    input.manifest === undefined ? readFile(manifestPath, "utf8") : Promise.resolve(undefined),
    readFile(articlePath, "utf8"),
  ]);

  const manifest: DeconstructManifest = input.manifest ?? JSON.parse(manifestRaw!);
  const allClips = manifest.clips;

  if (allClips.length === 0) {
    throw new Error("No clips found in manifest. Run deconstruct first.");
  }

  // Extract article title and derive short series name
  const titleMatch = articleMd.match(/^#\s+(.+)$/m);
  const articleTitle = titleMatch?.[1] ?? manifest.source.videoId;
  const seriesName = deriveSeriesName(articleTitle);

  // Build LLM input — all candidates
  const clipsInput = clipsInputForManifest(manifest);
  const sourceTextByClipId = Object.freeze(Object.fromEntries(allClips.map((clip) => [
    clip.id,
    buildClipSourceText(clip, articleMd),
  ])));

  const sourceText = clipPostSourceTextFor(articleMd, manifest);
  const selected = manifest.clips.filter((clip) => clip.selected === true && Boolean(clip.text));
  const selectedCacheIdentity = selectedClipPostCacheIdentityFor(articleTitle, manifest, sourceTextByClipId);
  const selectedSourceText = selectedCacheIdentity.sourceText;
  const sourceFingerprint = selectedCacheIdentity.sourceFingerprint;
  const bundleMetadataPath = contentTargetMetadataPathFor(clipsDir, "clip-post");
  const legacyMetadataPath = contentTargetMetadataPathFor(input.articleDir, "clip-post");
  const selectedPostPaths = selected.map((clip, index) => selectedPostPathFor(clipsDir, clip, index));
  if (input.persist !== false) {
    const bundleMetadata = await readContentTargetMetadata(bundleMetadataPath);
    const existingMetadata = bundleMetadata ?? await readContentTargetMetadata(legacyMetadataPath);
    const metadataPath = bundleMetadata === undefined ? legacyMetadataPath : bundleMetadataPath;
    const cacheHit = await isContentTargetMetadataFresh(existingMetadata, {
      target: "clip-post",
      sourceFingerprint,
      requestedModel: input.model,
      promptVersion: CONTENT_PROMPT_VERSIONS.clipPost,
      sourceText: selectedSourceText,
      sourceTitle: articleTitle,
      requiredFiles: [manifestPath, metadataPath, ...selectedPostPaths],
    });
    if (cacheHit && existingMetadata !== undefined) {
      const cacheGuard = createTechnicalTermGuard({
        sourceText: selectedSourceText,
        sourceTitle: articleTitle,
        discoveredTerms: existingMetadata.technicalTermDiscovery.acceptedCandidates,
        discovery: existingMetadata.technicalTermDiscovery,
      });
      return {
        postCount: manifest.clips.filter((clip) => typeof clip.text === "string" && clip.text.trim() !== "").length,
        postPaths: selectedPostPaths,
        manifest,
        technicalTerms: {
          guard: cacheGuard,
          restoration: { placeholders: [] },
          articleTitle,
          discoveredTerms: existingMetadata.technicalTermDiscovery.acceptedCandidates,
          discoveryAudit: existingMetadata.technicalTermDiscovery,
          sourceTextByClipId,
          model: input.model,
          requestedModel: input.model,
          resolvedModel: existingMetadata.resolvedModel,
          sourceFingerprint,
          promptVersion: CONTENT_PROMPT_VERSIONS.clipPost,
          profileFingerprint: existingMetadata.technicalTermProfileFingerprint,
        },
      };
    }
  }
  const discovery = await discoverTechnicalTerms({
    llm: input.llm,
    model: input.model,
    sourceText,
    sourceTitle: articleTitle,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const guard = createTechnicalTermGuard({
    sourceText,
    sourceTitle: articleTitle,
    discoveredTerms: discovery.accepted,
    discovery: technicalTermDiscoveryAuditFor(discovery),
  });
  const finalGuard = createTechnicalTermGuard({
    sourceText: `${sourceText}\n${CLIP_POST_CALL_TO_ACTION}`,
    sourceTitle: articleTitle,
    discoveredTerms: discovery.accepted,
    discovery: technicalTermDiscoveryAuditFor(discovery),
  });
  const finalTechnicalTerms: ClipPostTechnicalTerms = {
    guard: finalGuard,
    restoration: { placeholders: [] },
    articleTitle,
    discoveredTerms: discovery.accepted,
    discoveryAudit: technicalTermDiscoveryAuditFor(discovery),
    sourceTextByClipId,
    model: input.model,
    requestedModel: input.model,
    sourceFingerprint,
    promptVersion: CONTENT_PROMPT_VERSIONS.clipPost,
    profileFingerprint: finalGuard.profile.profileFingerprint,
  };
  const prepared = guard.prepare({
    articleTitle,
    seriesName,
    articlePath: manifest.source.articlePath,
    clips: clipsInput,
  });
  const preparedUserPrompt = buildPostUserPrompt(prepared.value);
  const systemPrompt = appendTechnicalTermRuleToSystemPrompt(CLIP_POST_SYSTEM_PROMPT, prepared.promptRule);

  const _t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: preparedUserPrompt },
    ],
    temperature: 0.4,
    maxTokens: 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  let finalized: FinalizedTechnicalTermValue<ClipPostList> = guard.finalize(
    parseClipPosts(resp.content),
    prepared.restoration,
  );
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    finalized = await repairTechnicalTermViolations({
      llm: input.llm,
      model: input.model,
      guard,
      currentValue: finalized.value,
      restoration: prepared.restoration,
      violations: finalized.violations,
      parseResponse: parseClipPosts,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  if (hasHardTechnicalTermViolations(finalized.violations)) {
    throw new Error(`Technical term validation failed: ${finalized.violations.map((item) => item.message).join("; ")}`);
  }
  const parsed = finalized.value;
  finalTechnicalTerms.resolvedModel = resp.model;

  // Write all candidates' copy into manifest JSON
  const total = parsed.posts.length;

  for (let i = 0; i < parsed.posts.length; i++) {
    const post = parsed.posts[i]!;
    const clip = allClips[i]!;

    // Build post text with AI Agents leverage template structure
    const videoLine = `🎬 视频 ${clip.video}（${Math.round(clip.timecodes.durationSec)}s）`;
    const articleLine = `📖 完整文章：${manifest.source.articlePath}`;
    // Last post appends YouTube link
    const articleFooter = i < total - 1
      ? articleLine
      : `${articleLine}\n🔗 https://www.youtube.com/watch?v=${manifest.source.videoId}`;

    const postLines = [
      post.opening_quote,
      "",
      post.core_description,
      "",
      post.video_suggestion,
      "",
      videoLine,
      "",
      articleFooter,
    ];
    const postText = postLines.join("\n");

    // Update manifest entry
    const manifestEntry = manifest.clips.find((c) => c.id === clip.id);
    if (manifestEntry) {
      manifestEntry.text = postText;
      manifestEntry.charCount = postText.length;
      manifestEntry.postTitle = post.title;
    }
  }

  // Only write .md files for selected clips
  const postPaths = input.persist === false
    ? []
    : await writeSelectedPostFiles(manifest, input.articleDir, finalTechnicalTerms, { lock: false });

  const result: GeneratePostsRunnerResult = {
    postCount: total,
    postPaths,
    manifest,
    technicalTerms: finalTechnicalTerms,
  };
  if (resp.usage !== undefined) {
    result.usage = {
      promptTokens: resp.usage.promptTokens,
      completionTokens: resp.usage.completionTokens,
    };
  }
  return result;
};

/**
 * Write post-*.md files for clips with selected=true.
 * Re-numbers series titles based on selected count.
 */
export const writeSelectedPostFiles = async (
  manifest: DeconstructManifest,
  articleDir: string,
  technicalTerms: ClipPostTechnicalTerms,
  options: {
    clipsDir?: string;
    metadataPath?: string;
    lock?: boolean;
  } = {},
): Promise<string[]> => {
  if (options.lock !== false) {
    return withContentTargetLock(articleDir, "deconstruct", () => writeSelectedPostFiles(
      manifest,
      articleDir,
      technicalTerms,
      { ...options, lock: false },
    ));
  }
  const clipsDir = options.clipsDir ?? path.join(articleDir, "x-format", "clips");
  const manifestPath = path.join(clipsDir, "clips-manifest.json");
  const postPaths: string[] = [];

  // 必须和 selectedClipPostCacheIdentityFor 的过滤条件一致（selected && 有 text）。
  // 否则 finalGuard 用来构建 sourceText 的 selected 集合会比 known/required
  // fingerprint 对应的集合更宽，profileFingerprint 永远无法从磁盘重建，clip-post
  // 缓存永久 miss。
  const selected = manifest.clips.filter((c) => c.selected === true && Boolean(c.text));

  const restoration = technicalTerms.restoration;
  const youtubeUrl = `https://www.youtube.com/watch?v=${manifest.source.videoId}`;
  const assembledTexts = selected.map((clip, index) => {
    if (!clip.text) return "";
    const baseText = stripClipPostYoutubeLink(stripClipPostCallToAction(clip.text));
    return index === selected.length - 1
      ? `${baseText}\n🔗 ${youtubeUrl}\n\n${CLIP_POST_CALL_TO_ACTION}`
      : baseText;
  });
  const selectedSourceText = selectedClipPostSourceText(
    selected,
    technicalTerms.articleTitle,
    technicalTerms.sourceTextByClipId,
    technicalTerms,
  );
  const finalGuard = createTechnicalTermGuard({
    sourceText: selectedSourceText,
    sourceTitle: technicalTerms.articleTitle,
    discoveredTerms: technicalTerms.discoveredTerms,
    ...(technicalTerms.discoveryAudit === undefined ? {} : { discovery: technicalTerms.discoveryAudit }),
  });
  const selectedCacheIdentity = selectedClipPostCacheIdentityFor(
    technicalTerms.articleTitle,
    manifest,
    technicalTerms.sourceTextByClipId,
    technicalTerms,
  );

  // 每个选中片段单独派生 source scope，避免片段 A 的术语被片段 B 的正文
  // “至少出现一次”而掩盖。此处只在内存中组装和校验，之后才接触旧文件。
  const finalizedTexts = assembledTexts.map((text, index) => {
    const clip = selected[index]!;
    if (!clip.text) return "";
    const clipSourceText = [
      sourceTextForSelectedClip(clip, technicalTerms),
      CLIP_POST_CALL_TO_ACTION,
    ].join("\n");
    const clipGuard = createTechnicalTermGuard({
      sourceText: clipSourceText,
      discoveredTerms: technicalTerms.discoveredTerms,
      ...(technicalTerms.discoveryAudit === undefined ? {} : { discovery: technicalTerms.discoveryAudit }),
    });
    const selectedSourceCanonicals = new Set(clipGuard.profile.occurrences.map((item) => item.canonical));
    const rejectingCanonicals = new Set(clipGuard.profile.entries
      .filter((term) => term.forbiddenTranslationHandling === "reject")
      .map((term) => term.canonical));
    const sourceTranslationViolations = clipGuard.validate([text]).filter((violation) =>
      violation.code === "forbidden-translation"
        && violation.canonical !== undefined
        && selectedSourceCanonicals.has(violation.canonical)
        && rejectingCanonicals.has(violation.canonical),
    );
    if (hasHardTechnicalTermViolations(sourceTranslationViolations)) {
      throw new Error(`Technical term validation failed: ${sourceTranslationViolations.map((item) => item.message).join("; ")}`);
    }
    const finalized = clipGuard.finalize([text], restoration);
    const normalized = normalizeControlledYoutubeUrl(finalized.value[0] ?? "", youtubeUrl);
    const finalViolations = finalized.violations.filter((violation) =>
      !isControlledYoutubeUrlViolation(violation, finalized.value, youtubeUrl),
    );
    const blockingViolations = clipGuard.validate([normalized]).filter((violation) =>
      !isControlledYoutubeUrlViolation(violation, [normalized], youtubeUrl),
    );
    if (hasHardTechnicalTermViolations(finalViolations)
      || hasHardTechnicalTermViolations(blockingViolations)) {
      const violations = [...finalViolations, ...blockingViolations];
      throw new Error(`Technical term validation failed: ${violations.map((item) => item.message).join("; ")}`);
    }
    return normalized;
  });

  const nextManifest = JSON.parse(JSON.stringify(manifest)) as DeconstructManifest;
  nextManifest.generatedAt = new Date().toISOString();
  for (let i = 0; i < selected.length; i++) {
    const clip = selected[i]!;
    if (!clip.text) continue;
    const slug = clip.slug || clip.id;
    const postPath = path.join(clipsDir, `post-${i + 1}-${slug}.md`);
    const finalText = finalizedTexts[i]!;
    const nextClip = nextManifest.clips.find((candidate) => candidate.id === clip.id);
    if (nextClip !== undefined) {
      nextClip.text = finalText;
      nextClip.charCount = finalText.length;
    }
    postPaths.push(postPath);
  }

  const schemaResult = DeconstructManifestSchema.safeParse(nextManifest);
  if (!schemaResult.success) {
    throw new Error(`Deconstruct manifest post-process result does not match expected schema: ${schemaResult.error.message}`);
  }

  const existing = await readdir(clipsDir).catch(() => [] as string[]);
  const stalePosts = existing.filter((file) => /^post-\d+-.+\.md$/.test(file));
  const stageDir = path.join(clipsDir, `.posts-stage-${process.pid}-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });
  try {
    let stagedMetadataPath: string | undefined;
    for (let i = 0; i < selected.length; i++) {
      const clip = selected[i]!;
      if (!clip.text) continue;
      const slug = clip.slug || clip.id;
      const fileName = `post-${i + 1}-${slug}.md`;
      const finalText = finalizedTexts[i]!;
      await writeFile(
        path.join(stageDir, fileName),
        `---\nref: clips-manifest.json\nclipId: ${clip.id}\ntype: clip-post\nplatform: x\nseries: ${i + 1}/${selected.length}\n---\n\n${finalText}\n`,
        "utf8",
      );
    }
    await writeFile(path.join(stageDir, "clips-manifest.json"), JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
    if (technicalTerms.requestedModel !== undefined
      && technicalTerms.sourceFingerprint !== undefined
      && technicalTerms.promptVersion !== undefined
      && technicalTerms.discoveryAudit !== undefined) {
      stagedMetadataPath = path.join(stageDir, ".content-metadata", "clip-post.json");
      await writeContentTargetMetadata(
        stagedMetadataPath,
        createContentTargetMetadata({
          target: "clip-post",
          sourceFingerprint: selectedCacheIdentity.sourceFingerprint,
          requestedModel: technicalTerms.requestedModel,
          resolvedModel: technicalTerms.resolvedModel ?? technicalTerms.requestedModel,
          promptVersion: technicalTerms.promptVersion,
          technicalTermProfileFingerprint: finalGuard.profile.profileFingerprint,
          technicalTermDiscovery: technicalTerms.discoveryAudit,
          technicalTermKnownSourceFingerprint: contentTechnicalTermSourceFingerprintFor(
            selectedCacheIdentity.sourceText,
            technicalTerms.articleTitle,
          ),
          technicalTermRequiredSourceFingerprint: contentTechnicalTermSourceFingerprintFor(
            selectedCacheIdentity.sourceText,
            technicalTerms.articleTitle,
          ),
        }),
      );
    }

    for (const filePath of postPaths) {
      await rename(path.join(stageDir, path.basename(filePath)), filePath);
    }
    await rename(path.join(stageDir, "clips-manifest.json"), manifestPath);
    if (stagedMetadataPath !== undefined) {
      const metadataPath = options.metadataPath ?? contentTargetMetadataPathFor(clipsDir, "clip-post");
      await mkdir(path.dirname(metadataPath), { recursive: true });
      await rename(stagedMetadataPath, metadataPath);
    }
    await Promise.all(stalePosts
      .filter((file) => !postPaths.some((postPath) => path.basename(postPath) === file))
      .map((file) => unlink(path.join(clipsDir, file)).catch(() => {})));
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
  return postPaths;
};

const stripClipPostCallToAction = (text: string): string => {
  return text
    .split("\n")
    .filter((line) => line.trim() !== CLIP_POST_CALL_TO_ACTION)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const stripClipPostYoutubeLink = (text: string): string => {
  return text
    .split("\n")
    .filter((line) => !/^🔗 https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)/iu.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const isControlledYoutubeUrlViolation = (
  violation: { code: string; canonical?: string },
  texts: readonly string[],
  expectedUrl: string,
): boolean => {
  if (violation.code !== "invented-canonical-term" || violation.canonical !== "YouTube") return false;
  if (!texts.at(-1)?.includes(expectedUrl)) return false;
  return texts.every((text, index) => {
    const withoutExpectedUrl = index === texts.length - 1 ? text.replace(expectedUrl, "") : text;
    return !/youtube/iu.test(withoutExpectedUrl);
  });
};

const normalizeControlledYoutubeUrl = (text: string, expectedUrl: string): string => {
  return text.replace(expectedUrl.replace("youtube.com", "YouTube.com"), expectedUrl);
};

const buildClipSourceText = (
  clip: DeconstructManifest["clips"][number],
  articleMd: string,
): string => {
  if (clip.sourceContext !== undefined) return sourceContextText(clip.sourceContext);
  const sourceRecord = clip as unknown as Record<string, unknown>;
  const optionalSourceFields = [
    "summary",
    "articleBody",
    "body",
    "keyQuote",
    "quote",
    "segmentTranscript",
    "transcript",
  ].map((key) => sourceRecord[key]).filter((value): value is string => typeof value === "string");
  return [
    clip.title,
    clip.articleSection ?? "",
    extractArticleSection(articleMd, clip.articleSection),
    ...optionalSourceFields,
  ].filter(Boolean).join("\n");
};

const sourceTextForSelectedClip = (
  clip: DeconstructManifest["clips"][number],
  technicalTerms: ClipPostTechnicalTerms,
): string => {
  if (clip.sourceContext !== undefined) return sourceContextText(clip.sourceContext);
  return technicalTerms.sourceTextByClipId?.[clip.id]
    ?? [clip.title, clip.articleSection ?? ""].join("\n");
};

/**
 * 没有 in-memory `technicalTerms`（即从磁盘 manifest 重建身份，如 CLI 缓存命中检查）
 * 时使用的候选源文本回退。必须和 `sourceTextForSelectedClip` 在 `clip.sourceContext`
 * 存在时保持一致 —— 否则从磁盘重建的 sourceText 会比生成时实际使用的文本更「贫瘠」，
 * 导致 profileFingerprint 永远无法从 metadata 精确重建，缓存永远不命中。
 */
const clipSourceTextForSelection = (
  clip: DeconstructManifest["clips"][number],
  sourceTextByClipId?: Readonly<Record<string, string>>,
): string => {
  if (clip.sourceContext !== undefined) return sourceContextText(clip.sourceContext);
  return sourceTextByClipId?.[clip.id] ?? [clip.title, clip.articleSection ?? ""].join("\n");
};

const selectedClipPostSourceText = (
  selected: readonly DeconstructManifest["clips"][number][],
  articleTitle: string,
  sourceTextByClipId?: Readonly<Record<string, string>>,
  technicalTerms?: ClipPostTechnicalTerms,
): string => [
  articleTitle,
  ...selected.map((clip) => technicalTerms === undefined
    ? clipSourceTextForSelection(clip, sourceTextByClipId)
    : sourceTextForSelectedClip(clip, technicalTerms)),
  CLIP_POST_CALL_TO_ACTION,
].join("\n");

const selectedPostPathFor = (
  clipsDir: string,
  clip: DeconstructManifest["clips"][number],
  index: number,
): string => {
  const slug = clip.slug || clip.id;
  return path.join(clipsDir, `post-${index + 1}-${slug}.md`);
};

const sourceContextText = (
  sourceContext: NonNullable<DeconstructManifest["clips"][number]["sourceContext"]>,
): string => [
  sourceContext.title,
  sourceContext.summary,
  sourceContext.keyQuote,
  sourceContext.videoScript,
  sourceContext.articleSection,
  sourceContext.articleBody,
].filter(Boolean).join("\n");

export const selectedClipPostCacheIdentityFor = (
  articleTitle: string,
  manifest: DeconstructManifest,
  sourceTextByClipId?: Readonly<Record<string, string>>,
  technicalTerms?: ClipPostTechnicalTerms,
): { sourceText: string; sourceFingerprint: string } => {
  const selected = manifest.clips.filter((clip) => clip.selected === true && Boolean(clip.text));
  const sourceText = selectedClipPostSourceText(
    selected,
    articleTitle,
    sourceTextByClipId,
    technicalTerms,
  );
  return {
    sourceText,
    sourceFingerprint: contentSourceFingerprintFor({
      articleTitle,
      selected: selected.map((clip) => ({
        id: clip.id,
        angle: clip.angle,
        video: clip.video,
        durationSec: clip.timecodes.durationSec,
        sourceText: technicalTerms === undefined
          ? clipSourceTextForSelection(clip, sourceTextByClipId)
          : sourceTextForSelectedClip(clip, technicalTerms),
      })),
      callToAction: CLIP_POST_CALL_TO_ACTION,
    }),
  };
};

const extractArticleSection = (articleMd: string, sectionTitle: string | undefined): string => {
  const target = sectionTitle?.trim();
  if (!target) return "";
  const lines = articleMd.split("\n");
  const headingIndex = lines.findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/u);
    return match !== null && match[2]!.replaceAll("**", "").trim() === target;
  });
  if (headingIndex < 0) return "";
  const level = lines[headingIndex]!.match(/^#+/u)![0].length;
  const nextHeadingOffset = lines.slice(headingIndex + 1).findIndex((line) => {
    const match = line.match(/^(#{1,6})\s+/u);
    return match !== null && match[1]!.length <= level;
  });
  const end = nextHeadingOffset < 0 ? lines.length : headingIndex + 1 + nextHeadingOffset;
  return lines.slice(headingIndex, end).join("\n");
};

const parseClipPosts = (raw: string): ClipPostList => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Clip posts LLM response is not JSON: ${msg}`);
  }
  const result = ClipPostListSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Clip posts schema error: ${result.error.message}`);
  }
  return result.data;
};
