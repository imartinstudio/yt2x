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
  usage?: { promptTokens: number; completionTokens: number };
};

const JSON_FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
const stripFence = (s: string): string => {
  const m = s.match(JSON_FENCE_RE);
  return m ? m[1]!.trim() : s.trim();
};

/**
 * 为所有候选 clip 生成帖子文案，全部写入 manifest JSON。
 * 不写单独的 .md 文件——.md 文件只对选中的 clip 生成。
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
  // 使用全部候选（不再过滤 selected）
  const allClips = manifest.clips;

  if (allClips.length === 0) {
    throw new Error("No clips found in manifest. Run deconstruct first.");
  }

  // Extract article title and derive short series name
  const titleMatch = articleMd.match(/^#\s+(.+)$/m);
  const articleTitle = titleMatch?.[1] ?? manifest.source.videoId;
  const seriesName = deriveSeriesName(articleTitle);

  // Build LLM input — 传入全部候选
  const clipsInput: GeneratePostsInput["clips"] = allClips.map((c) => ({
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

  // 全部候选的文案写入 manifest JSON（不写 .md 文件）
  const total = parsed.posts.length;

  for (let i = 0; i < parsed.posts.length; i++) {
    const post = parsed.posts[i]!;
    const clip = allClips[i]!;

    // Build full post text
    const seriesLine = formatClipPostSeriesTitle({
      articleTitle,
      seriesName,
      clipTitle: clip.title,
      index: i + 1,
      total: allClips.length,
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

    // Update manifest entry — 全部候选写入 JSON
    const manifestEntry = manifest.clips.find((c) => c.id === clip.id);
    if (manifestEntry) {
      manifestEntry.text = postText;
      manifestEntry.charCount = postText.length;
      manifestEntry.firstLineChars = post.first_line.length;
      manifestEntry.nextTeaser = post.teaser_next;
    }
  }

  // Write updated manifest (all post text in JSON)
  manifest.generatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // 只对已选中的 clip 生成 .md 文件
  const postPaths = await writeSelectedPostFiles(manifest, articleTitle, seriesName, input.articleDir);

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
 * 为 manifest 中 selected=true 的 clip 写入 post-*.md 文件。
 * 可在 selection 之后单独调用，只生成选中 clip 的 .md。
 */
export const writeSelectedPostFiles = async (
  manifest: DeconstructManifest,
  articleTitle: string,
  seriesName: string,
  articleDir: string,
): Promise<string[]> => {
  const clipsDir = path.join(articleDir, "clips");
  const postPaths: string[] = [];
  const selected = manifest.clips.filter((c) => c.selected === true);

  for (let i = 0; i < selected.length; i++) {
    const clip = selected[i]!;
    if (!clip.text) continue; // 文案未生成，跳过

    const slug = clip.slug || clip.id;
    const postPath = path.join(clipsDir, `post-${i + 1}-${slug}.md`);

    // 更新系列标识行——选中 clip 重新编号
    const originalText = clip.text;
    const seriesMarker = formatClipPostSeriesTitle({
      articleTitle,
      seriesName,
      clipTitle: clip.title,
      index: i + 1,
      total: selected.length,
    });
    // 替换原系列标识行（第一行）
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

/** angle → 戏剧性类型映射（与 core system prompt 表格一致） */
const ANGLE_DRAMA_MAP: Record<string, string> = {
  warning: "失控感——强调风险、后果、幸好及时止损。钩子要让人心里一紧。",
  contrarian: "反常识——打破常规认知。钩子用对比制造冲击：'你以为…其实是…'",
  tutorial: "高效感——强调速度、简化、一步到位。钩子聚焦'花了多久、省了多少'。",
  practical: "主动性——强调 AI 自动/主动行为。钩子让人感觉'它自己在干活'。",
  intro: "救赎感——从损失到恢复的转折。钩子先制造焦虑再给出解法。",
  outro: "救赎感——从损失到恢复的转折。钩子先制造焦虑再给出解法。",
  discussion: "反常识——制造认知冲突。钩子让人产生'跟我之前想的不一样'的疑惑。",
};

const buildPostUserPrompt = (input: GeneratePostsInput): string => {
  const parts: string[] = [];

  parts.push(`## 文章`);
  parts.push(`标题：${input.articleTitle}`);
  parts.push(`系列名称：${input.seriesName}`);
  parts.push(`系列标识行固定由程序生成，格式为「<emoji> <短标题> | N/N」。你不要生成这一行。`);
  parts.push("");

  parts.push(`## 候选章节（共 ${input.clips.length} 个，按发帖顺序排列）`);
  for (let i = 0; i < input.clips.length; i++) {
    const c = input.clips[i]!;
    const drama = ANGLE_DRAMA_MAP[c.angle] ?? "反常识——用对比制造冲击";
    parts.push("");
    parts.push(`### 第 ${i + 1} 篇`);
    parts.push(`标题：${c.title}`);
    parts.push(`角度（angle）：${c.angle}`);
    parts.push(`戏剧性类型：${drama}`);
    parts.push(`摘要：${c.summary}`);
    parts.push(`视频时长：${c.timecodes.durationSec}秒`);
    parts.push(`文件名：${c.video}`);
    parts.push(`⚠️ 这一篇的钩子必须体现【${drama.split("——")[0]}】，参考 system prompt 中对应的钩子特征。`);
  }
  parts.push("");
  parts.push(`请为以上 ${input.clips.length} 个章节各生成一条帖子文案。`);
  parts.push("对每条帖子，先内部 draft 3 个钩子、自检打分、选最优——但最终 JSON 只包含选中的版本。");
  parts.push("输出的 posts 数组顺序必须与输入顺序一致。");

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
  clipTitle: string;
  index: number;
  total: number;
};

export const formatClipPostSeriesTitle = (input: FormatClipPostSeriesTitleInput): string => {
  const shortSeries = deriveSeriesName(input.seriesName);
  return `🎬 ${shortSeries}：${input.clipTitle} | ${input.index}/${input.total}`;
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
