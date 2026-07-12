import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CLIP_POST_CALL_TO_ACTION,
  CLIP_POST_SYSTEM_PROMPT,
  deriveSeriesName,
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
  const manifestPath = path.join(input.articleDir, "x-format", "clips", "clips-manifest.json");
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
    maxTokens: 8192,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });

  const parsed = parseClipPosts(resp.content);

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
  const clipsDir = path.join(articleDir, "x-format", "clips");
  const manifestPath = path.join(clipsDir, "clips-manifest.json");
  const postPaths: string[] = [];

  // Remove stale post-*.md files from previous runs so they don't pollute
  // the publish readiness check (e.g. old posts with wrong clipIds, series
  // numbers, or video filenames).
  try {
    const existing = await readdir(clipsDir);
    const stalePosts = existing.filter((f) => /^post-\d+-.+\.md$/.test(f));
    await Promise.all(stalePosts.map((f) => unlink(path.join(clipsDir, f)).catch(() => {})));
  } catch {
    // Directory may not exist yet — that's fine.
  }

  const selected = manifest.clips.filter((c) => c.selected === true);

  for (let i = 0; i < selected.length; i++) {
    const clip = selected[i]!;
    if (!clip.text) continue; // Copy not generated yet, skip

    const slug = clip.slug || clip.id;
    const postPath = path.join(clipsDir, `post-${i + 1}-${slug}.md`);
    const baseText = stripClipPostCallToAction(clip.text);
    const finalText = i === selected.length - 1
      ? `${baseText}\n\n${CLIP_POST_CALL_TO_ACTION}`
      : baseText;
    clip.text = finalText;
    clip.charCount = finalText.length;

    await writeFile(
      postPath,
      `---\nref: clips-manifest.json\nclipId: ${clip.id}\ntype: clip-post\nplatform: x\nseries: ${i + 1}/${selected.length}\n---\n\n${finalText}\n`,
      "utf8",
    );
    postPaths.push(postPath);
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
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
