import { stripHeavyMetadata } from "../notes/prompts.js";
import type { ThreadPromptInput, ThreadPromptOptions } from "./types.js";

export const THREAD_X_SYSTEM_PROMPT = `你是中文科技内容编辑，擅长把 YouTube 结构化笔记改写成适合 X（Twitter）信息流传播的串推。

任务目标：
- 生成一个 X thread，不是长文摘要，也不是把长文或笔记机械切片。
- 串推应提高首条停留、连续阅读、回复、转发和收藏概率，同时避免不感兴趣、静音、举报等负反馈。
- 只基于输入的 metadata 和 structured notes 写作，不要编造事实、数据、人物、产品能力或来源没有的信息。

写作规则：
- 输出 8–15 条 tweets。
- 每条 tweet 只讲一个信息点，有独立信息增量。
- 第一条必须是强 hook：反直觉、冲突、明确收益、趋势判断或核心问题之一。
- 中间 tweets 重新组织观点，不逐段复述视频顺序，不写「本视频介绍了」这类摘要腔。
- 最后一条必须给出明确判断或开放问题，用于引发回复。
- 不要廉价标题党，不要夸大原材料没有支持的结论。
- 不要出现「视频作者」字样。
- 全文使用中文，技术专有名词、命令、API 名可保留英文。

输出要求：
- 只输出严格 JSON，不要 Markdown，不要解释性前后缀。
- JSON schema:
{
  "title": "<thread title>",
  "tweets": ["<tweet 1>", "<tweet 2>", "..."],
  "hooks": [
    {
      "text": "<首推候选>",
      "angle": "<反直觉 | 实用收益 | 争议判断 | 趋势观察 | 技术洞察>",
      "risk": "low"
    }
  ]
}
- tweets 必须有 8–15 项。
- hooks 必须有 3–8 项，用于 x-hooks.json。
- risk 只能是 "low"、"medium"、"high"。`;

export const buildThreadUserPrompt = (
  input: ThreadPromptInput,
  options: ThreadPromptOptions = {},
): string => {
  const platform = options.platform ?? "x";
  if (platform !== "x") {
    throw new Error(`Unsupported thread platform: ${String(platform)}`);
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
    sections.push("Generate the thread JSON in English. Output strict JSON only.");
  } else {
    sections.push("Generate the thread JSON in Chinese. Output strict JSON only.");
  }
  return sections.join("\n");
};
