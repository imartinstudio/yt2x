import { stripHeavyMetadata } from "../notes/prompts.js";
import {
  getPlatformArticleSpec,
  type PlatformArticleSpec,
  type PlatformArticleTarget,
} from "./platforms.js";

export type PlatformArticlePromptInput = {
  metadata: Record<string, unknown>;
  articleMd: string;
  timestampedCuesMd?: string;
};

export type PlatformArticlePromptOptions = {
  target: PlatformArticleTarget;
};

const buildSharedRules = (spec: PlatformArticleSpec): string => `通用约束：
- 目标平台：${spec.displayName}。
- 只基于输入的 article.md、metadata.json 和可选 timestamped-cues.md 适配，不新增事实、数据、案例、价格、链接或承诺。
- 可以改变表达方式、标题角度和内容顺序，但不能改变原文观点、结论和风险边界。
- 全文使用自然简体中文（zh-CN）；技术名词、命令、产品名可保留英文。
- 不要出现「视频作者」字样。
- 不要输出解释性前后缀，不要用 Markdown 代码围栏包裹 JSON。
- 输出必须能分别渲染为 ${spec.outputs.map((output) => output.path).join(" 和 ")}。`;

const XIAOHONGSHU_SYSTEM_PROMPT = `${buildSharedRules(getPlatformArticleSpec("xiaohongshu"))}

小红书适配目标：
- 生成图文笔记文案，不是 X 长文摘要，也不是公众号文章。
- 语气要偏种草型、强情绪、强钩子，但不得廉价标题党或夸大来源没有的效果。
- 开头 3 行必须快速给出痛点、反差或读者收益，让用户愿意停留。
- 正文适合移动端阅读，短段落、强节奏、可收藏。
- 必须给出 5 个标题候选。
- 必须给出 3-5 个核心标签，标签只从主题、工具、场景、读者问题中提取。
- 必须给出封面/配图建议，说明画面主体、文字层级和首图卖点。

输出 JSON schema：
{
  "target": "xiaohongshu",
  "titles": ["<5 个标题候选>"],
  "body": "<小红书图文笔记正文 Markdown，可直接复制发布>",
  "tags": ["<3-5 个核心标签，不带 # 也可>"],
  "cover": {
    "headline": "<封面主标题>",
    "subhead": "<封面副标题>",
    "visual_prompt": "<封面/配图设计说明>"
  },
  "notes": ["<可选：发布注意事项或素材建议>"]
}`;

const WECHAT_SYSTEM_PROMPT = `${buildSharedRules(getPlatformArticleSpec("wechat"))}

微信公众号适配目标：
- 生成完整 Markdown 长文，适合直接进入公众号编辑器排版。
- 保留主稿的信息密度和论证链条，但调整为公众号的阅读节奏：标题、摘要、导语、小节、结尾判断要完整。
- 标题策略：生成 1 个主标题 + 3 个备选标题。
- 必须生成摘要和开头导语。
- 必须给出封面图提示词 / 设计说明。
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
- 标题默认强冲突、高点击，但必须忠实来源，不得虚构结果、绝对化承诺或冒充官方信息。
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
  const sections: string[] = [];
  sections.push("## Video metadata (JSON)");
  sections.push("```json");
  sections.push(JSON.stringify(meta, null, 2));
  sections.push("```");
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
