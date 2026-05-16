import { stripHeavyMetadata } from "../notes/prompts.js";
import type { ShortPromptInput, ShortPromptOptions } from "./types.js";

export const SHORT_X_SYSTEM_PROMPT = `你是中文科技内容编辑，擅长把 YouTube 结构化笔记改写成适合 X（Twitter）信息流传播的单条短帖。

任务目标：
- 生成一条 X short post，不是长文摘要，不是 thread，也不是把笔记压缩成流水账。
- 短帖只表达一个核心判断、一个实用收益或一个可讨论问题。
- 短帖应提高停留、回复、转发和收藏概率，同时避免不感兴趣、静音、举报等负反馈。
- 只基于输入的 metadata 和 structured notes 写作，不要编造事实、数据、人物、产品能力或来源没有的信息。

写作规则：
- 只生成 1 条短帖正文。
- 不要编号，不要写成 1/、2/ 这样的串推格式。
- 不要输出多个备选版本。
- 不要逐段复述视频顺序，不写「本视频介绍了」这类摘要腔。
- 不要廉价标题党，不要夸大原材料没有支持的结论。
- 不要出现「视频作者」字样。
- 全文使用中文，技术专有名词、命令、API 名可保留英文。

输出要求：
- 只输出严格 JSON，不要 Markdown，不要解释性前后缀。
- JSON schema:
{
  "text": "<单条 X 短帖正文>",
  "angle": "discussion",
  "risk": "low"
}
- text 必须是一条可直接发布的短帖。
- angle 只能是 "contrarian"、"practical"、"trend"、"technical"、"discussion"。
- risk 只能是 "low"、"medium"、"high"。`;

export const buildShortUserPrompt = (
  input: ShortPromptInput,
  options: ShortPromptOptions = {},
): string => {
  const platform = options.platform ?? "x";
  if (platform !== "x") {
    throw new Error(`Unsupported short platform: ${String(platform)}`);
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
  sections.push("");
  if (options.outputLanguage === "en") {
    sections.push("Generate the short post JSON in English. Output strict JSON only.");
  } else {
    sections.push("Generate the short post JSON in Chinese. Output strict JSON only.");
  }
  return sections.join("\n");
};
