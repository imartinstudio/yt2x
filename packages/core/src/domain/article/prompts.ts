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

Emoji 策略：
- 长文默认不使用 emoji，保持专业文字风格。
- 仅在需要标记风险⚠️、验证✓、步骤①②③、关键结论💡时可以使用语义 emoji。
- emoji 是语义锚点，不是装饰；每条小节最多 0–1 个。
- 禁止在标题使用 emoji，禁止 emoji 列表或纯装饰性连续 emoji。

截图配图规则：
- 如上方提供了 available_visuals，你可以选择其中 1–3 张截图插入正文合适位置，用 Markdown 图片语法 \`![caption](screenshots/<file>)\`。
- 必须引用 available_visuals 中真实存在的 visual_id 对应的文件路径；不得虚构图片或路径。
- 仅选择能增强信息表达的截图：配置界面、命令输出、验证结果、流程节点、对比画面优先。
- 截图 caption 必须描述图片中实际包含的信息，不得编造图片外的内容。
- 如果没有 available_visuals 或没有合适的截图，不要写任何图片引用。

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

  const visuals = input.availableVisuals ?? null;
  if (visuals !== null && visuals.length > 0) {
    sections.push("");
    sections.push("## Available screenshots (available_visuals)");
    sections.push("");
    sections.push(
      "以下截图已从视频关键帧中提取并经过质量筛选。你可以在文章中引用它们，但只能引用下面列出的 visual_id 对应的图片文件。",
    );
    sections.push("");
    sections.push("```json");
    sections.push(JSON.stringify(visuals, null, 2));
    sections.push("```");
    sections.push("");
    sections.push(
      "引用格式：`![caption](screenshots/<file>)`。禁止引用未在 available_visuals 中出现的图片文件或 visual_id。",
    );
  }

  sections.push("");
  sections.push("## Structured notes (Markdown source)");
  sections.push("");
  sections.push(input.structuredNotesMd.trim());
  return sections.join("\n");
};
