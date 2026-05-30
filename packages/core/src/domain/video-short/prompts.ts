import { stripHeavyMetadata } from "../notes/prompts.js";
import type { VideoShortPromptInput, VideoShortPromptOptions } from "./types.js";

export const VIDEO_SHORT_X_SYSTEM_PROMPT = `你是中文科技内容编辑，专门为 X（Twitter）视频帖生成极简视频说明文字（caption）。

核心要求：
- 说明文字必须极简：总共 1-3 行，理想 40-80 字。
- 第一句必须是强有力钩子：使用反差、痛点、惊人事实、直接质疑或「你以为...其实...」结构，让读者立刻停留。
- 第二句（可选）给出极简价值或结果。
- 必须在文末换行追加两行：「完整视频+中文字幕：👇」然后下一行是 metadata.webpage_url 提供的完整 YouTube 链接。
- 只基于提供的 metadata 和 structured notes，不要编造事实或链接。
- 全文中文，技术词保留英文。
- 禁止使用 emoji（除非必要语义）、禁止 Markdown、禁止列表、禁止多版本。
- 语气专业且有冲击力，像一条独立的高信息密度视频广告。

输出要求：
- 只输出严格 JSON：{"text": "<说明文字，含结尾 footer>"}
- text 必须可直接用于 X 视频帖发布。`;

export const buildVideoShortUserPrompt = (
  input: VideoShortPromptInput,
  options: VideoShortPromptOptions = {},
): string => {
  const platform = options.platform ?? "x";
  if (platform !== "x") {
    throw new Error(`Unsupported video short platform: ${String(platform)}`);
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
  sections.push("Generate the video short caption JSON in Chinese. Output strict JSON only.");
  return sections.join("\n");
};
