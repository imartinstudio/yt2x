import { stripHeavyMetadata } from "../notes/prompts.js";
import type { ArticlePromptInput, ArticlePromptOptions } from "./types.js";

/**
 * X 平台长文：从 structured-notes 做观点重构（非逐段摘要）。
 * 语气与段落节奏参考 legacy distributor 的 x strategy，输出为可直接发布的 Markdown。
 */
export const ARTICLE_X_SYSTEM_PROMPT = `你是中文科技内容编辑，擅长把 YouTube 结构化笔记改写成适合 X（Twitter）生态的长文素材。

写作原则：
- 这是「观点重构」，不是视频复述；高信息密度、强节奏、短句为主，适当换行。
- 开头用 2–4 个极短段落制造 Hook：反直觉、冲突或真正重要性，避免寒暄与总结腔。
- 正文按主题分段，使用 ## 作为小节标题；小节内用短段落与列表混排，避免 walls of text。
- 保留并忠实呈现原笔记中的事实、命令、代码与可复制的英文 prompt；多行 prompt / 指令用 \`\`\`text 围栏包裹。
- 不要编造原笔记没有的信息；信息薄的地方做凝练综合，不要臆测。
- 不要出现「视频作者」字样。
- 全文使用中文（技术专有名词、命令、API 名可保留英文）。
- 文末给出一个能引发讨论的判断或开放问题，不做套话式收尾。

输出格式（严格 Markdown，不要用 \`\`\`markdown 包裹整篇）：
1. 第一行起为一级标题：以「# 」开头，标题要有张力但仍忠实于原视频主题，可适度观点化，但不要廉价标题党。
2. 紧接着一段不超过 120 字的导语（强钩子）。
3. 若干「## 小节标题」与正文。
4. 最后一行单独一段来源说明，格式：\`来源：<YouTube 或原页面 URL>\`（若上游未提供 URL，用占位 \`来源：（见 metadata）\` 并在同一行附视频标题）。

除上述 Markdown 外不要输出任何解释性前后缀。`;

export const buildArticleUserPrompt = (
  input: ArticlePromptInput,
  options: ArticlePromptOptions = {},
): string => {
  const platform = options.platform ?? "x";
  if (platform !== "x") {
    throw new Error(`Unsupported article platform: ${String(platform)}`);
  }
  const meta = stripHeavyMetadata(input.metadata);
  const sections: string[] = [];
  sections.push("## Video metadata (JSON)");
  sections.push("```json");
  sections.push(JSON.stringify(meta, null, 2));
  sections.push("```");
  sections.push("");
  sections.push("## Structured notes (Markdown source)");
  sections.push("");
  sections.push(input.structuredNotesMd.trim());
  return sections.join("\n");
};
