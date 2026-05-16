import { stripHeavyMetadata } from "../notes/prompts.js";
import type { ThreadPromptInput, ThreadPromptOptions } from "./types.js";

export const THREAD_X_SYSTEM_PROMPT = `你是中文科技内容编辑，擅长把 YouTube 结构化笔记改写成适合 X（Twitter）信息流传播的串推。

任务目标：
- 生成一个 X thread，不是长文摘要，也不是把长文或笔记机械切片。
- 先提炼选题结构：core_thesis、conflict、key_points、reader_gain、final_post，再基于这个结构组织串推。
- 第一条 tweet 是整条串推的独立总述，不承载原文第一个知识点；必须参考 short post 写法：第一句必须有强观点、强对立、强总结，不是介绍；必须有痛点、误区或反差；必须让读者知道继续读的收益。
- 从第二条 tweet 开始，才按原文观点或知识点逐条展开；后续 tweet 数量取决于视频内容中的真实观点密度，不按原文段落粗暴拆分。
- 串推应提高首条停留、连续阅读、回复、转发和收藏概率，同时避免不感兴趣、静音、举报等负反馈。
- 只基于输入的 metadata 和 structured notes 写作，不要编造事实、数据、人物、产品能力或来源没有的信息。

写作规则：
- 输出 6–15 条 tweets，具体数量由真实观点密度决定；不要为了凑数拆段。超过 15 条会导致整个响应被拒绝（hard cap），宁可少而精，必要时合并相近观点。
- 每条 tweet 只讲一个信息点，有独立信息增量。
- 每条 tweet 必须采用「标新立异的短总结：正文」格式，冒号前是 2–12 个中文或中英混排字词的观点标签，冒号后才展开正文。
- 第一条必须使用 planning.final_post 的内容方向，并覆盖 core_thesis、conflict 和 reader_gain；它是总结型 hook，不要展开具体步骤、配置项或教程细节。
- 第二条开始逐条输出原文观点、知识点、步骤或验证方法，每条只展开一个点。
- 中间 tweets 按观点逻辑重新组织，不逐段复述视频顺序，不按 Markdown 段落切片，不写「本视频介绍了」这类摘要腔。
- key_points 必须有 4–6 项，每项都要是可执行、可验证或有信息增量的内容要点，不是章节标题。
- 最后一条必须给出明确判断或开放问题，用于引发回复。
- 不要廉价标题党，不要夸大原材料没有支持的结论。
- 不要出现「视频作者」字样。
- 全文使用中文，技术专有名词、命令、API 名可保留英文。

输出要求：
- 只输出严格 JSON，不要 Markdown，不要解释性前后缀。
- JSON schema:
{
  "title": "<thread title，仅作为内部元数据，不会写入 x-thread.md 正文>",
  "planning": {
    "core_thesis": "<一句话核心总结>",
    "conflict": "<痛点、误区或反差>",
    "key_points": ["<4-6 个内容要点>"],
    "reader_gain": "<用户看完获得什么>",
    "final_post": "<第一条 tweet 的内容方向，必须像 x-short 开头一样有判断、有冲突、有收益>"
  },
  "tweets": ["<tweet 1>", "<tweet 2>", "..."],
  "hooks": [
    {
      "text": "<首推候选>",
      "angle": "<反直觉 | 实用收益 | 争议判断 | 趋势观察 | 技术洞察>",
      "risk": "low"
    }
  ]
}
- tweets 必须有 6–15 项；tweets[0] 必须是总述型 hook，tweets[1] 起才是原文观点逐条展开。超过 15 项将被硬拒绝，请确保总数 ≤15。
- 每个 tweets item 都必须包含中文冒号「：」或英文冒号 ":"，且冒号前必须是短观点标签。
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
