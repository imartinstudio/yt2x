import { stripHeavyMetadata } from "../notes/prompts.js";
import {
  getPlatformArticleSpec,
  type PlatformArticleSpec,
  type PlatformArticleTarget,
} from "./platforms.js";
import { SHARED_NO_VIDEO_AUTHOR, SHARED_JSON_OUTPUT } from "../shared-rules.js";

export type PlatformArticlePromptInput = {
  metadata: Record<string, unknown>;
  articleMd: string;
  timestampedCuesMd?: string;
};

export type PlatformArticlePromptOptions = {
  target: PlatformArticleTarget;
};

const PROTECTED_TITLE_TERMS = [
  "Codex",
  "Claude",
  "Cluade",
  "ChatGPT",
  "GPT",
  "OpenAI",
  "Gemini",
  "DeepSeek",
  "Cursor",
  "GitHub Copilot",
] as const;

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const firstMarkdownH1 = (markdown: string): string | undefined => {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
};

export const extractProtectedTitleTerms = (sourceTitle: string | undefined): string[] => {
  if (sourceTitle === undefined) return [];
  const found: string[] = [];
  for (const term of PROTECTED_TITLE_TERMS) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(sourceTitle) && !found.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      found.push(term);
    }
  }
  return found;
};

export const getCanonicalTitleSeed = (input: PlatformArticlePromptInput): string | undefined =>
  firstString(input.metadata.title, input.metadata.fulltitle, input.metadata.original_title, firstMarkdownH1(input.articleMd));

const buildSharedRules = (spec: PlatformArticleSpec): string => `通用约束：
- 目标平台：${spec.displayName}。
- 只基于输入的 article.md、metadata.json 和可选 timestamped-cues.md 适配，不新增事实、数据、案例、价格、链接或承诺。
- 可以改变表达方式、标题角度和内容顺序，但不能改变原文观点、结论和风险边界。
- 全文必须使用简体中文（zh-CN）。禁止输出繁体中文。技术名词、命令、产品名可保留英文。这是硬性要求，不可违反。
- 每个二级标题前加 \`---\` 分割线（第一个二级标题除外）。
- 多平台标题必须从同一个「统一主标题」派生。小红书标题是统一主标题的缩减版（≤20 字，2 个英文字母算 1 字），B站标题与统一主标题保持一致。任何平台标题都不得引入原文没有的产品名、品牌名或术语（如原文没提 V0 就不能加 V0）。
- 如果原始标题、统一主标题或 metadata 中出现 Codex、Claude、ChatGPT、Gemini、DeepSeek、Cursor、GitHub Copilot 等特指名词，主标题必须保留对应名词，不能泛化成「AI 工具」「智能体」「编程助手」等宽泛说法。
- 标题必须体现内容适用范围和局限性，避免让读者误以为文章讨论的是更宽泛的产品、平台或方法。
- ${SHARED_NO_VIDEO_AUTHOR}
- ${SHARED_JSON_OUTPUT}
- 输出必须能分别渲染为 ${spec.outputs.map((output) => output.path).join(" 和 ")}。`;

const XIAOHONGSHU_SYSTEM_PROMPT = `${buildSharedRules(getPlatformArticleSpec("xiaohongshu"))}

小红书适配目标：
- 生成图文笔记文案，不是 X 长文摘要，也不是公众号文章。
- 语气要偏种草型、强情绪、强钩子，但不得廉价标题党或夸大来源没有的效果。
- 开头 3 行必须快速给出痛点、反差或读者收益，让用户愿意停留。
- 正文适合移动端阅读，短段落、强节奏、可收藏。
- 标题必须从统一主标题缩减而来，不换角度、不换主题。标题不超过 20 个字（2 个英文字母算 1 个字）。不得引入原文没有的产品名、品牌名或术语。
- 必须给出 3-5 个核心标签，标签只从主题、工具、场景、读者问题中提取。
- 不需要生成封面/配图建议和发布注意事项，这些由独立的视觉规划流程处理。
- **正文格式：纯文字 + emoji。禁止使用任何 Markdown 语法（包括标题 #、粗体 **、斜体 *、列表 -、引用 >、代码块、链接 []()、分割线 --- 等）。正文只能包含普通文字、换行和 emoji。**
- **正文总字数不超过 1000 字（以全角字符计数，英文字母和数字不计入字数上限）。超出 1000 字的内容将被截断。**

输出 JSON schema：
{
  "target": "xiaohongshu",
  "title": "<统一主标题>",
  "body": "<小红书图文笔记正文，纯文字 + emoji，无任何 Markdown 格式，不超过 1000 字>",
  "tags": ["<3-5 个核心标签，不带 # 也可>"]
}`;

const WECHAT_SYSTEM_PROMPT = `${buildSharedRules(getPlatformArticleSpec("wechat"))}

微信公众号适配目标：
- 生成完整 Markdown 长文，适合直接进入公众号编辑器排版。
- 保留主稿的信息密度和论证链条，但调整为公众号的阅读节奏：标题、摘要、导语、小节、结尾判断要完整。
- 标题策略：生成 1 个主标题 + 3 个备选标题；主标题必须是统一主标题，备选标题只能做轻微表达变体，不能换主题。
- 必须生成摘要和开头导语。
- 必须给出封面图提示词 / 设计说明；封面主标题必须使用统一主标题。
- 正文允许 Markdown 标题、列表、引用和代码块，但必须保持可读、可复制。

输出 JSON schema：
{
  "target": "wechat",
  "title": "<主标题>",
  "title_options": ["<3 个备选标题>"],
  "summary": "<公众号摘要>",
  "lead": "<开头导语>",
  "body": "<完整公众号 Markdown 正文>",
  "cover": {
    "headline": "<封面主标题>",
    "subhead": "<封面副标题>",
    "visual_prompt": "<封面图设计说明>"
  }
}`;

const BILIBILI_SYSTEM_PROMPT = `${buildSharedRules(getPlatformArticleSpec("bilibili"))}

哔哩哔哩适配目标：
- 生成视频发布信息，不是专栏文章。
- 标题必须与 X 文章统一主标题保持一致，不得换角度、换主题或引入原文没有的产品名/品牌名（如 V0、Cursor 等）。可以有 B 站点击感，但仅限表达方式微调，不能改变标题核心信息。
- 生成视频简介、分区建议、8-10 个标签。
- 需要生成章节时间线草案；如果输入提供 timestamped-cues.md，可参考时间戳，否则基于 article.md 结构生成粗略章节标题，不编造精确秒数。
- 简介要适合 B 站：先给冲突/看点，再给内容结构，最后给适合收藏或评论的问题。

输出 JSON schema：
{
  "target": "bilibili",
  "title": "<强冲突、高点击但忠实来源的视频标题>",
  "description": "<视频简介>",
  "category": "<分区建议>",
  "tags": ["<8-10 个标签>"],
  "timeline": [
    {
      "time": "<可选时间，如 00:00；没有可靠时间时留空字符串>",
      "title": "<章节标题>",
      "description": "<章节看点>"
    }
  ],
  "comment_prompt": "<引导评论的问题>"
}`;

export const getPlatformArticleSystemPrompt = (target: PlatformArticleTarget): string => {
  if (target === "xiaohongshu") return XIAOHONGSHU_SYSTEM_PROMPT;
  if (target === "wechat") return WECHAT_SYSTEM_PROMPT;
  return BILIBILI_SYSTEM_PROMPT;
};

export const buildPlatformArticleUserPrompt = (
  input: PlatformArticlePromptInput,
  options: PlatformArticlePromptOptions,
): string => {
  const meta = stripHeavyMetadata(input.metadata);
  const canonicalTitle = getCanonicalTitleSeed(input);
  const protectedTerms = extractProtectedTitleTerms(
    [
      canonicalTitle,
      firstString(input.metadata.title, input.metadata.fulltitle, input.metadata.original_title),
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n"),
  );
  const sections: string[] = [];
  sections.push("## Video metadata (JSON)");
  sections.push("```json");
  sections.push(JSON.stringify(meta, null, 2));
  sections.push("```");
  sections.push("");
  sections.push("## Unified title constraints");
  sections.push("");
  sections.push(
    canonicalTitle !== undefined
      ? `- Unified main title seed: ${canonicalTitle}`
      : "- Unified main title seed: infer from article.md, but keep the same main title across platforms.",
  );
  if (protectedTerms.length > 0) {
    sections.push(`- Required title terms: ${protectedTerms.join(", ")}`);
    sections.push("- Every platform main title and cover headline must include these exact terms.");
  } else {
    sections.push("- If the source title contains a specific product/tool/person name, keep it in the main title.");
  }
  sections.push(
    "- Do not broaden a title about a specific tool into a generic AI/productivity/programming title.",
  );
  sections.push("");
  sections.push("## Source article.md");
  sections.push("");
  sections.push(input.articleMd.trim());

  if (input.timestampedCuesMd !== undefined && input.timestampedCuesMd.trim().length > 0) {
    sections.push("");
    sections.push("## Optional timestamped cues");
    sections.push("");
    sections.push(input.timestampedCuesMd.trim());
  }

  sections.push("");
  sections.push(`Generate the ${options.target} adaptation as strict JSON only.`);
  return sections.join("\n");
};
