import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLIP_POST_SYSTEM_PROMPT, type ClipPostList, type DeconstructManifest, type GeneratePostsInput, type LlmPort } from "@yt2x/core";
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
};

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripFence = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m ? m[1]!.trim() : s.trim();
};

/**
 * 为已选中的 clip 生成帖子文案并写入 post-*.md 文件。
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
  const selected = manifest.clips.filter((c) => c.selected);

  if (selected.length === 0) {
    throw new Error("No selected clips found. Run `yt2x clips select` first.");
  }

  // Extract article title and derive short series name
  const titleMatch = articleMd.match(/^#\s+(.+)$/m);
  const articleTitle = titleMatch?.[1] ?? manifest.source.videoId;
  const seriesName = deriveSeriesName(articleTitle);

  // Build LLM input
  const clipsInput: GeneratePostsInput["clips"] = selected.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.scores?.composite !== undefined
      ? `${c.title}（评分 ${c.scores.composite.toFixed(1)}）：${c.articleSection ?? ""}`
      : c.title,
    angle: c.angle,
    timecodes: { durationSec: Math.round(c.timecodes.durationSec) },
    video: c.video,
    key_quote: undefined,
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

  // Write post files + update manifest
  const clipsDir = path.join(input.articleDir, "clips");
  const postPaths: string[] = [];
  const total = parsed.posts.length;

  for (let i = 0; i < parsed.posts.length; i++) {
    const post = parsed.posts[i]!;
    const clip = selected[i]!;

    // Build full post text
    const seriesLine = formatClipPostSeriesTitle({
      articleTitle,
      seriesName,
      index: i + 1,
      total,
    });
    const videoLine = `🎬 视频 ${clip.video}（${Math.round(clip.timecodes.durationSec)}s）`;
    const teaserLine = i < total - 1
      ? post.teaser_next
      : `完整长文 👇\n🔗 https://www.youtube.com/watch?v=${manifest.source.videoId}`;
    const articleLine = `📖 完整文章：${manifest.source.articlePath}`;

    const postLines = [
      seriesLine,
      "",
      post.first_line,
      "",
      post.body,
      "",
      videoLine,
      "",
      articleLine,
      "",
      teaserLine,
      post.hashtags,
    ];
    const postText = postLines.join("\n");

    // Write .md file
    const slug = clip.slug || `clip-${i + 1}`;
    const postPath = path.join(clipsDir, `post-${i + 1}-${slug}.md`);
    await writeFile(
      postPath,
      `---\nref: clips-manifest.json\nclipId: ${clip.id}\ntype: clip-post\nplatform: x\nseries: ${i + 1}/${total}\n---\n\n${postText}\n`,
      "utf8",
    );
    postPaths.push(postPath);

    // Update manifest entry
    const manifestEntry = manifest.clips.find((c) => c.id === clip.id);
    if (manifestEntry) {
      const fullText = postText;
      manifestEntry.text = fullText;
      manifestEntry.charCount = fullText.length;
      manifestEntry.firstLineChars = post.first_line.length;
      manifestEntry.nextTeaser = post.teaser_next;
    }
  }

  // Write updated manifest
  manifest.generatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    postCount: postPaths.length,
    postPaths,
  };
};

const buildPostUserPrompt = (input: GeneratePostsInput): string => {
  const parts: string[] = [];

  parts.push(`## 文章`);
  parts.push(`标题：${input.articleTitle}`);
  parts.push(`系列名称：${input.seriesName}`);
  parts.push(`路径：${input.articlePath}`);
  parts.push(`系列标识行固定由程序生成，格式为「<emoji> <短标题> | N/N」。短标题必须呼应文章大标题，不能另起无关主题。`);
  parts.push("");

  parts.push(`## 候选章节（共 ${input.clips.length} 个，按发帖顺序排列）`);
  for (let i = 0; i < input.clips.length; i++) {
    const c = input.clips[i]!;
    parts.push("");
    parts.push(`### 第 ${i + 1} 篇`);
    parts.push(`标题：${c.title}`);
    parts.push(`角度：${c.angle}`);
    parts.push(`摘要：${c.summary}`);
    parts.push(`视频时长：${c.timecodes.durationSec}秒`);
    parts.push(`文件名：${c.video}`);
  }
  parts.push("");
  parts.push("请为每个章节生成一条帖子文案。输出的 posts 数组顺序必须与输入顺序一致。");

  return parts.join("\n");
};

/**
 * 从文章标题推导短系列名称。
 * 例: "Claude Code 刚把网站设计行业翻了个底朝天" → "Claude Code 实战"
 *      "10 个 Claude Code 插件，让你的项目效率翻 10 倍" → "Claude Code 插件"
 *      "浏览器已死，Codex 和 Claude Code 才是知识工作的未来" → "AI 知识工作"
 */
export const deriveSeriesName = (title: string): string => {
  const cleaned = title.replace(/^#?\s*[*#]*\s*/, "").replace(/\*\*/g, "").trim();
  // Try to extract the topic before common delimiters
  // ASCII comma only splits when NOT between digits (e.g., 10,000 stays intact)
  const delimiters = /[，。.！!？?—‒–—:：]|(?<!\d),(?!\d)/;
  const firstPart = cleaned.split(delimiters)[0]?.trim() ?? cleaned;
  // Truncate to ~40 chars max to preserve enough context
  const short = Array.from(firstPart).slice(0, 40).join("").trim();
  // Append a generic suffix if too short or looks incomplete
  if (short.length <= 4) return `${short}深度拆解`;
  return short;
};

const CLIP_TITLE_EMOJI_RULES = [
  { key: "claude", emoji: "🧠", pattern: /\bClaude(?:\s+Code)?\b/i },
  { key: "codex", emoji: "🤖", pattern: /\bCodex\b/i },
  { key: "chatgpt", emoji: "💬", pattern: /\bChatGPT\b|\bGPT\b/i },
  { key: "gemini", emoji: "💎", pattern: /\bGemini\b/i },
  { key: "deepseek", emoji: "🔎", pattern: /\bDeepSeek\b/i },
  { key: "cursor", emoji: "⌨️", pattern: /\bCursor\b/i },
  { key: "copilot", emoji: "🛠️", pattern: /\b(?:GitHub\s+)?Copilot\b/i },
] as const;

export const chooseClipTitleEmoji = (title: string): string => {
  const matches = CLIP_TITLE_EMOJI_RULES.filter((rule) => rule.pattern.test(title));
  const uniqueKeys = new Set(matches.map((rule) => rule.key));
  if (uniqueKeys.size === 1) return matches[0]!.emoji;
  if (uniqueKeys.size > 1) return "🧭";
  return "🧩";
};

export type FormatClipPostSeriesTitleInput = {
  articleTitle: string;
  seriesName: string;
  index: number;
  total: number;
};

export const formatClipPostSeriesTitle = (input: FormatClipPostSeriesTitleInput): string => {
  const shortTitle = deriveSeriesName(input.seriesName);
  const emoji = chooseClipTitleEmoji(input.articleTitle);
  return `${emoji} ${shortTitle} | ${input.index}/${input.total}`;
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
