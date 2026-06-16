import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLIP_POST_SYSTEM_PROMPT,
  deriveSeriesName,
  formatClipPostSeriesTitle,
  type ClipPostList,
  type DeconstructManifest,
  type GeneratePostsInput,
  type LlmPort,
} from "@yt2x/core";
import { ClipPostListSchema } from "@yt2x/core";

export type GeneratePostsRunnerInput = {
  llm: LlmPort;
  model: string;
  articleDir: string;
  signal?: AbortSignal;
};

export type GeneratePostsRunnerResult = {
  postCount: number;
  postPaths: string[];
  usage?: { promptTokens: number; completionTokens: number };
};

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripFence = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m ? m[1]!.trim() : s.trim();
};

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

  return parts.join("\n");
};

/**
 * Generate post copy for all candidate clips, writing all to manifest JSON.
 * Only writes separate .md files for clips that are already selected=true.
 */
export const generateClipsPosts = async (
  input: GeneratePostsRunnerInput,
): Promise<GeneratePostsRunnerResult> => {
  const manifestPath = path.join(input.articleDir, "clips", "clips-manifest.json");
  const articlePath = path.join(input.articleDir, "article.md");

  const [manifestRaw, articleMd] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(articlePath, "utf8"),
  ]);

  const manifest: DeconstructManifest = JSON.parse(manifestRaw);
  const allClips = manifest.clips;

  if (allClips.length === 0) {
    throw new Error("No clips found in manifest. Run deconstruct first.");
  }

  // Extract article title and derive short series name
  const titleMatch = articleMd.match(/^#\s+(.+)$/m);
  const articleTitle = titleMatch?.[1] ?? manifest.source.videoId;
  const seriesName = deriveSeriesName(articleTitle);

  // Build LLM input — all candidates
  const clipsInput: GeneratePostsInput["clips"] = allClips.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.scores?.composite !== undefined
      ? `${c.title}（评分 ${c.scores.composite.toFixed(1)}）：${c.articleSection ?? ""}`
      : c.title,
    angle: c.angle,
    timecodes: { durationSec: Math.round(c.timecodes.durationSec) },
    video: c.video,
  }));

  const userPrompt = buildPostUserPrompt({
    articleTitle,
    seriesName,
    articlePath: manifest.source.articlePath,
    clips: clipsInput,
  });

  const _t0 = Date.now();
  const resp = await input.llm.chat({
    model: input.model,
    messages: [
      { role: "system", content: CLIP_POST_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: 4096,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const parsed = parseClipPosts(resp.content);

  // Write all candidates' copy into manifest JSON
  const total = parsed.posts.length;

  for (let i = 0; i < parsed.posts.length; i++) {
    const post = parsed.posts[i]!;
    const clip = allClips[i]!;

    // Build post text with 4-segment Martin AI Coding Workflow structure
    const seriesLine = formatClipPostSeriesTitle({
      clipTitle: post.title,
      index: i + 1,
      total: allClips.length,
    });
    const videoLine = `🎬 视频 ${clip.video}（${Math.round(clip.timecodes.durationSec)}s）`;
    const articleLine = `📖 完整文章：${manifest.source.articlePath}`;
    // Last post appends YouTube link
    const articleFooter = i < total - 1
      ? articleLine
      : `${articleLine}\n🔗 https://www.youtube.com/watch?v=${manifest.source.videoId}`;

    const postLines = [
      seriesLine,
      "",
      post.conflict,
      "",
      post.what_happened,
      "",
      post.conclusion,
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

  // Write updated manifest (all post text in JSON)
  manifest.generatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Only write .md files for selected clips
  const postPaths = await writeSelectedPostFiles(manifest, input.articleDir);

  const result: GeneratePostsRunnerResult = {
    postCount: total,
    postPaths,
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
): Promise<string[]> => {
  const clipsDir = path.join(articleDir, "clips");
  const postPaths: string[] = [];
  const selected = manifest.clips.filter((c) => c.selected === true);

  for (let i = 0; i < selected.length; i++) {
    const clip = selected[i]!;
    if (!clip.text) continue; // Copy not generated yet, skip

    const slug = clip.slug || clip.id;
    const postPath = path.join(clipsDir, `post-${i + 1}-${slug}.md`);

    // Rebuild series title line with re-numbered index
    const clipTitle = clip.postTitle ?? clip.title;
    const seriesMarker = formatClipPostSeriesTitle({
      clipTitle,
      index: i + 1,
      total: selected.length,
    });

    // Replace the original series title line (first line of text)
    const originalText = clip.text;
    const lines = originalText.split("\n");
    lines[0] = seriesMarker;
    const renumberedText = lines.join("\n");

    await writeFile(
      postPath,
      `---\nref: clips-manifest.json\nclipId: ${clip.id}\ntype: clip-post\nplatform: x\nseries: ${i + 1}/${selected.length}\n---\n\n${renumberedText}\n`,
      "utf8",
    );
    postPaths.push(postPath);
  }

  return postPaths;
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
