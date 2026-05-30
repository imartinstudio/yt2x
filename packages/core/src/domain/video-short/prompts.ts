import { stripHeavyMetadata } from "../notes/prompts.js";
import type { VideoShortPromptInput, VideoShortPromptOptions } from "./types.js";

export const VIDEO_SHORT_X_SYSTEM_PROMPT = `你是中文科技内容编辑，专门为 X（Twitter）视频帖生成短视频说明文字（caption）。

核心要求：
- 必须包含三部分（顺序固定）：1. 强有力钩子 2. 视频核心观点提炼 3. 总结/价值
- 钩子必须强化冲突、对立、反差或突出，让读者立刻产生强烈好奇或认同
- 观点提炼部分必须把视频中的主要观点/框架/方法至少提到 2-4 个关键点
- 最后一句给出总结或读者能获得的明确价值/结果

**格式要求（和 x-short 一样严格，必须严格遵守）：**
- 钩子写完后必须换行 + 空一行
- 观点提炼部分写完后必须换行 + 空一行
- 总结部分单独成一段
- 三部分之间必须有空行，不能连在一起写
- 禁止把所有内容写成一段
- 整体控制在 4-7 行

**语气要求**：语气自然直接，像真人说话即可

必须在总结部分之后空一行，再追加单独一行「完整视频+中文字幕：👇」，此行之后不要加任何链接或其他内容
只基于提供的 metadata 和 structured notes，不要编造事实或链接
全文中文，技术词保留英文
禁止使用 emoji（除非必要语义）、禁止 Markdown、禁止列表、禁止多版本

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
